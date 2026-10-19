import { validCedula } from '@intitaxi/testkit';
import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, grantConsent, startedTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let operator: Awaited<ReturnType<typeof adminSession>>;
let dpo: Awaited<ReturnType<typeof adminSession>>;
beforeAll(async () => {
  await s.start(['auth', 'api', 'sos']);
  operator = await adminSession(s, 'sos_operator');
  dpo = await adminSession(s, 'dpo');
});
afterAll(() => s.stop());

const ecuLog = async () => (await (await fetch(`${s.urls.sos}/v1/dev/ecu911`)).json()) as any[];

describe('Manifiesto del viaje', () => {
  it('se genera al iniciar y al terminar: cifrado, encadenado y firmado', async () => {
    const third = { givenNames: 'Carmen', familyNames: 'Vera Loor', idType: 'cedula', idNumber: validCedula(), email: `m${Date.now()}@correo.test`, phone: '0981234567' };
    const { drv, tripId } = await startedTrip(s, { extra: { forThirdParty: third } });
    await drv.d.call('api', 'POST', `/v1/driver/trips/${tripId}/complete`);
    const rows = await waitFor(() => s.pool.query('SELECT version, reason, payload_enc FROM safety.trip_manifests WHERE trip_id = $1 ORDER BY version', [tripId]), (r) => r.rows.length >= 2);
    expect(rows.rows.map((r) => r.reason)).toEqual(['start', 'end']);
    expect(rows.rows.map((r) => r.payload_enc.toString('latin1')).join('')).not.toContain('Carmen');
    await expect(s.pool.query(`UPDATE safety.trip_manifests SET reason = 'end' WHERE trip_id = $1`, [tripId])).rejects.toThrow(/solo inserción/);
    await expect(s.pool.query(`DELETE FROM safety.trip_manifests WHERE trip_id = $1`, [tripId])).rejects.toThrow(/solo inserción/);
  });
});

describe('Botón SOS', () => {
  it('pasajero: incidente, retención legal, aviso a contactos de confianza y escalamiento automático al ECU 911 (simulado)', async () => {
    const p = await s.loggedIn();
    expect((await p.d.call('auth', 'POST', '/v1/me/trusted-contacts', { name: 'Rosa Pérez', phone: '0997776655' })).status).toBe(201);
    const { tripId, drv } = await startedTrip(s, { passenger: p });
    // Sin ticket de atestación: el SOS no puede fallar por eso
    p.d.ticket = '';
    const sos = await p.d.call('sos', 'POST', '/v1/sos', { tripId, location: { lat: -2.16, lng: -79.89 } });
    expect(sos.status).toBe(201);
    expect(sos.body).toMatchObject({ status: 'open', call: 'tel:911' });
    // Activar dos veces no duplica el incidente
    expect((await p.d.call('sos', 'POST', '/v1/sos', { tripId })).body.incidentId).toBe(sos.body.incidentId);
    expect((await s.pool.query('SELECT incident_hold FROM trips.trips WHERE id = $1', [tripId])).rows[0].incident_hold).toBe(true);
    const sms = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === '+593997776655' && x.text.includes('ALERTA')));
    expect(sms.find((x) => x.to === '+593997776655' && x.text.includes('ALERTA'))!.text).toContain(drv.plate);
    // Nadie atiende en 5 s → se escala solo (fail-safe)
    const log = await waitFor(ecuLog, (l) => l.some((e) => e.kind === 'report' && e.plate === drv.plate), 15000);
    expect(log.find((e) => e.kind === 'report' && e.plate === drv.plate)).toMatchObject({ type: 'sos', people: 2, signed: true });
    // El operador ve el incidente con el manifiesto descifrado e íntegro
    const list = await operator.web.call('sos', 'GET', '/v1/admin/incidents');
    expect(list.body.some((i: { id: string }) => i.id === sos.body.incidentId)).toBe(true);
    const detail = await operator.web.call('sos', 'GET', `/v1/admin/incidents/${sos.body.incidentId}`);
    expect(detail.body.manifest.integrity).toBe('verified');
    expect(detail.body.manifest.payload.vehicle.plate).toBe(drv.plate);
    expect(detail.body.manifest.payload.driver.latestBiometricVerification).toBeTruthy();
    const audit = await s.pool.query(`SELECT purpose FROM audit.audit_log WHERE action = 'incident.view' AND resource_id = $1`, [sos.body.incidentId]);
    expect(audit.rows[0].purpose).toBe('sos_response');
  });

  it('cancelar con PIN; con el PIN de coacción parece cancelado pero se agrava y se escala', async () => {
    const p = await s.loggedIn();
    expect((await p.d.call('sos', 'PUT', '/v1/me/safety-pins', { pin: '2468', duressPin: '1357' })).status).toBe(200);
    const a = await startedTrip(s, { passenger: p });
    const sos1 = await p.d.call('sos', 'POST', '/v1/sos', { tripId: a.tripId });
    expect((await p.d.call('sos', 'POST', `/v1/sos/${sos1.body.incidentId}/cancel`, { pin: '0000' })).status).toBe(400);
    const ok = await p.d.call('sos', 'POST', `/v1/sos/${sos1.body.incidentId}/cancel`, { pin: '2468' });
    await a.drv.d.call('api', 'POST', `/v1/driver/trips/${a.tripId}/complete`);

    const b = await startedTrip(s, { passenger: p });
    const sos2 = await p.d.call('sos', 'POST', '/v1/sos', { tripId: b.tripId });
    const duress = await p.d.call('sos', 'POST', `/v1/sos/${sos2.body.incidentId}/cancel`, { pin: '1357' });
    // Respuesta idéntica para quien mira el teléfono
    expect(duress.body.status).toBe(ok.body.status);
    expect((await p.d.call('sos', 'GET', `/v1/sos/${sos2.body.incidentId}`)).body.status).toBe('cancelled');
    const { rows } = await s.pool.query('SELECT status, severity, duress, ecu911_status FROM safety.incidents WHERE id = $1', [sos2.body.incidentId]);
    expect(rows[0]).toMatchObject({ status: 'escalated', severity: 'critical', duress: true, ecu911_status: 'simulated' });
  });

  it('solo los participantes del viaje pueden activar el SOS; el tercero sin app, desde su enlace', async () => {
    const third = { givenNames: 'Lucía', familyNames: 'Mora', idType: 'cedula', idNumber: validCedula(), email: `l${Date.now()}@correo.test`, phone: '0985554433' };
    const { tripId } = await startedTrip(s, { extra: { forThirdParty: third } });
    const stranger = await s.loggedIn();
    expect((await stranger.d.call('sos', 'POST', '/v1/sos', { tripId })).status).toBe(404);
    const sms = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === '+593985554433'));
    const token = /\/t\/([A-Za-z0-9_-]{43})/.exec(sms.find((x) => x.to === '+593985554433')!.text)![1];
    const r = await fetch(`${s.urls.sos}/v1/track/${token}/sos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: { lat: -2.17, lng: -79.9 } }) });
    expect(r.status).toBe(201);
    expect((await s.pool.query('SELECT opened_by_role FROM safety.incidents WHERE trip_id = $1', [tripId])).rows[0].opened_by_role).toBe('link_holder');
  });

  it('el conductor reporta un accidente', async () => {
    const { drv, tripId } = await startedTrip(s);
    const r = await drv.d.call('sos', 'POST', `/v1/driver/trips/${tripId}/accident`, { location: { lat: -2.18, lng: -79.88 } });
    expect(r.status).toBe(201);
    expect((await s.pool.query('SELECT type FROM safety.incidents WHERE id = $1', [r.body.incidentId])).rows[0].type).toBe('accident');
  });

  it('audio: solo con consentimiento previo y guardado cifrado', async () => {
    const p = await s.loggedIn();
    const { tripId } = await startedTrip(s, { passenger: p });
    const sos = await p.d.call('sos', 'POST', '/v1/sos', { tripId });
    const send = async () => {
      const proofHeaders = await (async () => {
        const { createDpopProof } = await import('@intitaxi/auth-client');
        const url = `${s.urls.sos}/v1/sos/${sos.body.incidentId}/audio?seq=${Date.now() % 100000}`;
        return { url, headers: { Authorization: `DPoP ${p.d.accessToken}`, DPoP: await createDpopProof(p.d.signer, { method: 'POST', url, accessToken: p.d.accessToken }), 'Content-Type': 'audio/aac' } };
      })();
      return fetch(proofHeaders.url, { method: 'POST', headers: proofHeaders.headers, body: Buffer.from('AUDIO-DE-PRUEBA-'.repeat(50)) });
    };
    expect((await send()).status).toBe(403);
    await grantConsent(p.d, 'audio_recording');
    expect((await send()).status).toBe(201);
    const { rows } = await s.pool.query('SELECT storage_key FROM safety.audio_chunks WHERE incident_id = $1', [sos.body.incidentId]);
    const { readFile } = await import('node:fs/promises');
    const stored = await readFile(`${process.cwd()}/../.data/storage/${rows[0].storage_key}`).catch(async () => readFile(`${process.cwd()}/.data/storage/${rows[0].storage_key}`));
    expect(stored.toString('latin1')).not.toContain('AUDIO-DE-PRUEBA');
  });
});

describe('Entrega a autoridades', () => {
  it('doble aprobación, enlace temporal con límite de accesos, marca de agua y firma verificable', async () => {
    const { tripId } = await startedTrip(s);
    const req = await operator.web.call('sos', 'POST', '/v1/admin/authority-disclosures', { tripId, authority: 'Fiscalía Provincial del Guayas', legalBasis: 'Oficio FGE-2026-123 (requerimiento judicial)' });
    expect(req.status).toBe(201);
    // Quien solicita no puede aprobar
    const self = await adminSession(s, 'dpo');
    const selfReq = await self.web.call('sos', 'POST', '/v1/admin/authority-disclosures', { tripId, authority: 'Policía Nacional', legalBasis: 'Oficio PN-2026-55 de prueba' });
    expect((await self.web.call('sos', 'POST', `/v1/admin/authority-disclosures/${selfReq.body.disclosureId}/approve`)).status).toBe(409);
    const ok = await dpo.web.call('sos', 'POST', `/v1/admin/authority-disclosures/${req.body.disclosureId}/approve`);
    expect(ok.status).toBe(200);
    const view = (await (await fetch(ok.body.url)).json()) as any;
    expect(view.watermark).toContain('Fiscalía Provincial del Guayas');
    expect(view.signature.integrity).toBe('verified');
    const valid = verify('sha256', Buffer.from(view.signature.chainHash, 'base64url'), createPublicKey(view.signature.publicKeyPem), Buffer.from(view.signature.signature, 'base64url'));
    expect(valid).toBe(true);
    for (let i = 0; i < 4; i++) await fetch(ok.body.url);
    expect((await fetch(ok.body.url)).status).toBe(404);
  });

  it('detecta un manifiesto adulterado', async () => {
    const { tripId, drv } = await startedTrip(s);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${tripId}/complete`);
    await waitFor(() => s.pool.query('SELECT 1 FROM safety.trip_manifests WHERE trip_id = $1 AND reason = $2', [tripId, 'end']), (r) => r.rows.length > 0);
    // Un atacante con acceso de escritura inserta una versión falsa
    await s.pool.query(
      `INSERT INTO safety.trip_manifests (id, trip_id, version, reason, payload_enc, payload_sha256, prev_hash, chain_hash, signature, key_id)
       SELECT gen_random_uuid(), trip_id, version + 1, 'end', payload_enc, payload_sha256, chain_hash, chain_hash, signature, key_id FROM safety.trip_manifests WHERE trip_id = $1 AND reason = 'end'`,
      [tripId],
    );
    const m = await operator.web.call('sos', 'GET', `/v1/admin/trips/${tripId}/manifest?reason=${encodeURIComponent('Verificación de integridad')}`);
    expect(m.body.integrity).toBe('TAMPERED');
  });
});
