import { validCedula } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, idemKey, MALECON, offerFor, onlineDriver, requestTrip, waitFor } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
let reviewer: Awaited<ReturnType<typeof adminSession>>['web'];
beforeAll(async () => {
  await s.start(['auth', 'api']);
  reviewer = (await adminSession(s, 'driver_reviewer')).web;
});
afterAll(() => s.stop());

const zone = (i: number) => ({ lat: -2.12 - i * 0.02, lng: -79.95 });
const adult = (n: string) => ({ givenNames: n, familyNames: 'Zambrano Ruiz', idType: 'cedula', idNumber: validCedula(), email: `${n.toLowerCase()}${Math.random().toString(36).slice(2, 7)}@correo.test`, isMinor: false });

describe('Acompañantes', () => {
  it('registra acompañantes, valida cédula y correo, y muestra la cédula enmascarada', async () => {
    const { d } = await s.loggedIn();
    const bad = await requestTrip(d, { companions: [{ ...adult('Luis'), idNumber: '0912345678' }] }, zone(1), MALECON);
    expect(bad.body.detail).toContain('cédula inválida');
    const noMail = await requestTrip(d, { companions: [{ ...adult('Luis'), email: undefined }] }, zone(1), MALECON);
    expect(noMail.body.detail).toContain('correo es obligatorio');

    const luis = adult('Luis');
    const t = await requestTrip(d, { companions: [luis, adult('Rosa')] }, zone(1), MALECON);
    expect(t.status).toBe(201);
    expect(t.body.partySize).toBe(3);
    const parties = await d.call('api', 'GET', `/v1/trips/${t.body.id}/parties`);
    const l = parties.body.people.find((p: { givenNames: string }) => p.givenNames === 'Luis');
    expect(l.document).toBe(`${luis.idNumber.slice(0, 2)}******${luis.idNumber.slice(-2)}`);
    // Datos cifrados en la BD
    const { rows } = await s.pool.query(`SELECT p.* FROM people.persons p JOIN trips.trip_parties tp ON tp.person_id = p.id WHERE tp.trip_id = $1`, [t.body.id]);
    expect(JSON.stringify(rows)).not.toContain(luis.idNumber);
    expect(JSON.stringify(rows)).not.toContain('Zambrano');
    // Aviso LOPDP a cada acompañante con correo
    const mail = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === luis.email));
    expect(mail.find((x) => x.to === luis.email)!.text).toContain('SOLO para la seguridad del viaje');
    // Cada lectura queda auditada con su finalidad
    const a = await s.pool.query(`SELECT purpose FROM audit.audit_log WHERE action = 'trip.parties_read' AND resource_id = $1`, [t.body.id]);
    expect(a.rows[0].purpose).toBe('trip_safety');
  });

  it('menores: sin correo, con adulto responsable que viaja', async () => {
    const { d } = await s.loggedIn();
    const kid = { givenNames: 'Mateo', familyNames: 'Zambrano', idType: 'none', isMinor: true, guardian: 'requester' };
    const t = await requestTrip(d, { companions: [kid] }, zone(2), MALECON);
    expect(t.status).toBe(201);
    const p = await d.call('api', 'GET', `/v1/trips/${t.body.id}/parties`);
    const m = p.body.people.find((x: { isMinor: boolean }) => x.isMinor);
    const req = p.body.people.find((x: { role: string }) => x.role === 'requester');
    expect(m.responsiblePersonId).toBe(req.personId);
    const orphan = await requestTrip((await s.loggedIn()).d, { companions: [{ ...kid, guardian: undefined }] }, zone(2), MALECON);
    expect(orphan.body.detail).toContain('adulto responsable');
  });

  it('no supera la capacidad del vehículo: un auto de 2 asientos no recibe un grupo de 3', async () => {
    const at = zone(3);
    const small = await onlineDriver(s, at, 2, reviewer);
    const { d } = await s.loggedIn();
    const t = await requestTrip(d, { companions: [adult('Ana'), adult('Eva')] }, at, MALECON);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await small.d.call('api', 'GET', '/v1/driver/offers')).body.filter((o: { tripId: string }) => o.tripId === t.body.id)).toEqual([]);
    expect((await requestTrip((await s.loggedIn()).d, { companions: Array.from({ length: 8 }, (_, i) => adult(`P${'abcdefgh'[i]}`)) }, at, MALECON)).status).toBe(400);
  });
});

describe('Viaje para un tercero', () => {
  it('el tercero recibe conductor, placa, PIN y enlace; el solicitante recibe aviso de llegada', async () => {
    const at = zone(4);
    const drv = await onlineDriver(s, at, 4, reviewer);
    const requester = await s.loggedIn();
    const third = { ...adult('Carmen'), phone: '0987654321' };
    const t = await requestTrip(requester.d, { forThirdParty: third }, at, MALECON);
    expect(t.status).toBe(201);
    await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
    const sms = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === '+593987654321' && x.channel === 'sms'));
    const msg = sms.find((x) => x.to === '+593987654321' && x.channel === 'sms')!.text;
    const pin = (await requester.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).body.pin;
    expect(msg).toContain(drv.plate);
    expect(msg).toContain(`PIN para subir: ${pin}`);
    expect(msg).toMatch(/\/t\/[A-Za-z0-9_-]{43}/);
    // El conductor solo ve el nombre del pasajero principal, sin documento
    const forDriver = await drv.d.call('api', 'GET', `/v1/trips/${t.body.id}/parties`);
    expect(forDriver.body.people).toEqual([expect.objectContaining({ role: 'primary_passenger', givenNames: 'Carmen', familyNames: null, document: null })]);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin });
    await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/complete`);
    const done = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === requester.phone.e164 && x.text.includes('llegó a su destino')));
    expect(done.length).toBeGreaterThan(0);
  });
});

describe('Derechos del titular y contactos frecuentes', () => {
  it('el acompañante consulta sus datos y pide la eliminación: diferida si el viaje está activo', async () => {
    const { d } = await s.loggedIn();
    const comp = adult('Pedro');
    await requestTrip(d, { companions: [comp] }, zone(5), MALECON);
    const mail = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === comp.email));
    const token = /\/p\/([A-Za-z0-9_-]{43})/.exec(mail.find((x) => x.to === comp.email)!.text)![1]!;
    const view = (await fetch(`${s.urls.api}/v1/privacy/subject/${token}`).then((r) => r.json())) as any;
    expect(view.datos).toMatchObject({ givenNames: 'Pedro', document: expect.stringContaining('******') });
    expect(view.conservacion).toContain('180 días');
    const del = (await fetch(`${s.urls.api}/v1/privacy/subject/${token}/delete`, { method: 'POST' }).then((r) => r.json())) as any;
    expect(del.status).toBe('deferred_legal_hold');
    expect((await fetch(`${s.urls.api}/v1/privacy/subject/AAAA${token.slice(4)}`)).status).toBe(404);
  });

  it('contactos frecuentes: solo se usan tras el consentimiento del acompañante', async () => {
    const { d } = await s.loggedIn();
    const comp = adult('Sofia');
    const saved = await d.call('api', 'POST', '/v1/companions', { ...comp, alias: 'Mi prima' });
    expect(saved.body.consentStatus).toBe('pending');
    const early = await requestTrip(d, { savedCompanionIds: [saved.body.id] }, zone(6), MALECON);
    expect(early.body.title).toBe('consent_pending');
    const mail = await waitFor(() => s.inbox(), (m) => m.some((x) => x.to === comp.email));
    const token = /\/p\/([A-Za-z0-9_-]{43})/.exec(mail.find((x) => x.to === comp.email)!.text)![1]!;
    await fetch(`${s.urls.api}/v1/privacy/subject/${token}/confirm`, { method: 'POST' });
    const ok = await requestTrip(d, { savedCompanionIds: [saved.body.id] }, zone(6), MALECON);
    expect(ok.status).toBe(201);
    expect(ok.body.partySize).toBe(2);
    // Otro usuario no puede usar ese contacto
    const other = await s.loggedIn();
    expect((await requestTrip(other.d, { savedCompanionIds: [saved.body.id] }, zone(7), MALECON)).status).toBe(404);
  });

  it('retención: a los 180 días se anonimiza, salvo viajes con incidente', async () => {
    const { d } = await s.loggedIn();
    const a = await requestTrip(d, { companions: [adult('Olga')] }, zone(8), MALECON);
    await d.call('api', 'POST', `/v1/trips/${a.body.id}/cancel`, {});
    const b = await requestTrip((await s.loggedIn()).d, { companions: [adult('Hugo')] }, zone(9), MALECON);
    await s.pool.query(`UPDATE trips.trips SET status = 'cancelled', incident_hold = true WHERE id = $1`, [b.body.id]);
    await s.pool.query(`UPDATE trips.trips SET retention_until = now() - interval '1 day' WHERE id = ANY($1)`, [[a.body.id, b.body.id]]);
    await fetch(`${s.urls.api}/v1/dev/retention/run`, { method: 'POST' });
    const { rows } = await s.pool.query(
      `SELECT tp.trip_id, p.anonymized_at IS NOT NULL AS anon, p.given_names_enc IS NULL AS wiped FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = ANY($1)`,
      [[a.body.id, b.body.id]],
    );
    expect(rows.filter((r) => r.trip_id === a.body.id).every((r) => r.anon && r.wiped)).toBe(true);
    expect(rows.filter((r) => r.trip_id === b.body.id).every((r) => !r.anon)).toBe(true);
    expect(idemKey()).toBeTruthy();
  });
});
