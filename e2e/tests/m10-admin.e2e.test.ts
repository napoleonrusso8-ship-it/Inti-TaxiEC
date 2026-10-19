import { validCedula } from '@intitaxi/testkit';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, completedTrip, randomCedula, startedTrip, verifiedUser } from '../src/flows.js';
import { PANEL_ORIGIN, Stack } from '../src/stack.js';

const s = new Stack();
type Admin = Awaited<ReturnType<typeof adminSession>>;
let support: Admin;
let fraud: Admin;
let dpo: Admin;
let auditor: Admin;
let reviewer: Admin;

beforeAll(async () => {
  await s.start(['auth', 'api', 'sos', 'admin']);
  [support, fraud, dpo, auditor, reviewer] = (await Promise.all(['support', 'fraud_analyst', 'dpo', 'auditor', 'driver_reviewer'].map((r) => adminSession(s, r)))) as [Admin, Admin, Admin, Admin, Admin];
}, 120_000);
afterAll(() => s.stop());

const zone = (i: number) => ({ lat: -2.13 - i * 0.015, lng: -79.93 });
const wallet = async (userId: string) => Number((await s.pool.query('SELECT coalesce(sum(credit_cents - debit_cents), 0) AS b FROM payments.ledger_entries WHERE account = $1', [`wallet:${userId}`])).rows[0].b);

describe('Métricas', () => {
  it('cualquier rol de administración las ve; no contienen datos personales; un pasajero no', async () => {
    const m = await auditor.web.call('api', 'GET', '/v1/admin/metrics');
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ timezone: 'America/Guayaquil', queues: expect.any(Object) });
    const raw = JSON.stringify(m.body);
    expect(raw).not.toMatch(/@|\+593|09\d{8}/);
    const p = await s.loggedIn();
    expect((await p.d.call('api', 'GET', '/v1/admin/metrics')).status).toBe(403);
  });
});

describe('Disputas', () => {
  it('el pasajero reclama; soporte ve el relato con motivo auditado y resuelve con reembolso a la billetera una sola vez', async () => {
    const { p, trip, drv } = await completedTrip(s, { at: zone(1), reviewer: reviewer.web });
    const tripId = trip.body.id;
    const stranger = await s.loggedIn();
    const body = { category: 'fare', description: 'El conductor tomó una ruta más larga de lo normal.' };
    expect((await stranger.d.call('api', 'POST', `/v1/trips/${tripId}/disputes`, body)).status).toBe(404);
    const open = await p.d.call('api', 'POST', `/v1/trips/${tripId}/disputes`, body);
    expect(open.status).toBe(201);
    expect((await p.d.call('api', 'POST', `/v1/trips/${tripId}/disputes`, body)).body.title).toBe('dispute_exists');
    // El conductor también puede reclamar el mismo viaje
    expect((await drv.d.call('api', 'POST', `/v1/trips/${tripId}/disputes`, { category: 'conduct', description: 'El pasajero dejó basura en el asiento.' })).status).toBe(201);
    // El relato va cifrado en la BD
    const row = await s.pool.query('SELECT description_enc FROM support.disputes WHERE id = $1', [open.body.id]);
    expect(row.rows[0].description_enc.toString('latin1')).not.toContain('ruta más larga');

    const list = await support.web.call('api', 'GET', '/v1/admin/disputes?status=open');
    const item = list.body.find((d: { id: string }) => d.id === open.body.id);
    expect(item).toBeTruthy();
    expect(item.description).toBeUndefined();
    expect((await support.web.call('api', 'GET', `/v1/admin/disputes/${open.body.id}`)).status).toBe(400);
    const detail = await support.web.call('api', 'GET', `/v1/admin/disputes/${open.body.id}?reason=${encodeURIComponent('Revisión del reclamo')}`);
    expect(detail.body.description).toBe(body.description);
    const audit = await s.pool.query(`SELECT purpose, actor_user_id FROM audit.audit_log WHERE action = 'dispute.view' AND resource_id = $1`, [open.body.id]);
    expect(audit.rows[0]).toMatchObject({ purpose: 'dispute_review', actor_user_id: support.userId });

    // Otro rol no puede
    expect((await auditor.web.call('api', 'GET', '/v1/admin/disputes')).status).toBe(403);

    const before = await wallet(p.userId);
    const resolve = (by: Admin) => by.web.call('api', 'POST', `/v1/admin/disputes/${open.body.id}/resolve`, { decision: 'resolved', resolution: 'Se compensa la diferencia de recorrido', refundCents: 100, refundTo: 'wallet' });
    const [a, b] = await Promise.all([resolve(support), resolve(support)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await wallet(p.userId)).toBe(before + 100);
    const mine = await p.d.call('api', 'GET', '/v1/disputes');
    expect(mine.body.find((d: { id: string }) => d.id === open.body.id)).toMatchObject({ status: 'resolved', refundCents: 100 });
  });

  it('no se reclama un viaje en curso', async () => {
    const { p, tripId } = await startedTrip(s);
    const r = await p.d.call('api', 'POST', `/v1/trips/${tripId}/disputes`, { category: 'other', description: 'Todavía voy en el vehículo' });
    expect(r.status).toBe(409);
    expect(r.body.title).toBe('trip_not_finished');
  });
});

describe('KYC: documentos duplicados', () => {
  it('fraud_analyst ve el documento enmascarado; "transferir" aprueba la cuenta nueva y revoca la anterior', async () => {
    const doc = randomCedula();
    const a = await verifiedUser(s, 'passenger', doc);
    const b = await verifiedUser(s, 'passenger', doc);
    expect((await b.d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('duplicate_review');
    const list = await fraud.web.call('api', 'GET', '/v1/admin/kyc/reviews');
    const item = list.body.find((r: { userId: string }) => r.userId === b.userId);
    expect(item.documentMasked).toMatch(/^\d{2}\*+\d{2}$/);
    expect(JSON.stringify(item)).not.toContain(doc);
    expect(item.conflictingAccounts.map((c: { userId: string }) => c.userId)).toEqual([a.userId]);
    expect((await support.web.call('api', 'GET', '/v1/admin/kyc/reviews')).status).toBe(403);
    const r = await fraud.web.call('api', 'POST', `/v1/admin/kyc/reviews/${item.id}/decision`, { decision: 'transfer', reason: 'Misma persona: perdió su número, confirmado por videollamada' });
    expect(r.body.status).toBe('approved');
    expect((await b.d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('approved');
    const old = await s.pool.query(`SELECT status FROM kyc.verifications WHERE user_id = $1 AND kind = 'full' ORDER BY created_at DESC LIMIT 1`, [a.userId]);
    expect(old.rows[0].status).toBe('revoked');
    const sig = await s.pool.query(`SELECT signal FROM payments.fraud_signals WHERE subject_id = ANY($1)`, [[a.userId, b.userId]]);
    expect(sig.rows.map((x) => x.signal).sort()).toEqual(['kyc_identity_transferred_in', 'kyc_identity_transferred_out']);
  });

  it('"rechazar" declina la verificación y abre una señal de fraude', async () => {
    const doc = randomCedula();
    await verifiedUser(s, 'passenger', doc);
    const c = await verifiedUser(s, 'passenger', doc);
    const item = (await fraud.web.call('api', 'GET', '/v1/admin/kyc/reviews')).body.find((r: { userId: string }) => r.userId === c.userId);
    await fraud.web.call('api', 'POST', `/v1/admin/kyc/reviews/${item.id}/decision`, { decision: 'reject', reason: 'Selfie no coincide con el titular original' });
    expect((await c.d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('declined');
    expect((await fraud.web.call('api', 'POST', `/v1/admin/kyc/reviews/${item.id}/decision`, { decision: 'reject', reason: 'Otra vez' })).status).toBe(404);
  });
});

describe('Privacidad (DPO)', () => {
  it('completar un borrado anonimiza a la persona; con retención legal no se puede', async () => {
    const third = () => ({ givenNames: 'Marta', familyNames: 'Ruiz León', idType: 'cedula', idNumber: validCedula(), email: `m${Math.random().toString(36).slice(2, 8)}@correo.test`, phone: '0981112233' });
    const dsr = async (tripId: string) => {
      const person = (await s.pool.query(`SELECT person_id FROM trips.trip_parties WHERE trip_id = $1 AND role = 'primary_passenger'`, [tripId])).rows[0].person_id;
      const id = crypto.randomUUID();
      await s.pool.query(`INSERT INTO people.data_subject_requests (id, person_id, type, status, due_at) VALUES ($1, $2, 'delete', 'received', now() + interval '15 days')`, [id, person]);
      return { id, person };
    };
    const t1 = await completedTrip(s, { at: zone(2), payment: { forThirdParty: third() }, reviewer: reviewer.web });
    const r1 = await dsr(t1.trip.body.id);
    const list = await dpo.web.call('api', 'GET', '/v1/admin/privacy-requests?status=received');
    expect(list.body.find((x: { id: string }) => x.id === r1.id)).toMatchObject({ type: 'delete', legalHold: false });
    const ok = await dpo.web.call('api', 'POST', `/v1/admin/privacy-requests/${r1.id}/decision`, { decision: 'complete', notes: 'Borrado solicitado por la titular' });
    expect(ok.body.status).toBe('completed');
    const p = await s.pool.query('SELECT given_names_enc, id_doc_masked, anonymized_at FROM people.persons WHERE id = $1', [r1.person]);
    expect(p.rows[0]).toMatchObject({ given_names_enc: null, id_doc_masked: null });
    expect(p.rows[0].anonymized_at).toBeTruthy();

    const t2 = await completedTrip(s, { at: zone(3), payment: { forThirdParty: third() }, reviewer: reviewer.web });
    await s.pool.query('UPDATE trips.trips SET incident_hold = true WHERE id = $1', [t2.trip.body.id]);
    const r2 = await dsr(t2.trip.body.id);
    const held = await dpo.web.call('api', 'POST', `/v1/admin/privacy-requests/${r2.id}/decision`, { decision: 'complete', notes: 'Intento de borrado' });
    expect(held.status).toBe(409);
    expect(held.body.title).toBe('legal_hold');
    expect((await support.web.call('api', 'GET', '/v1/admin/privacy-requests')).status).toBe(403);
  });
});

describe('Auditoría (auditor)', () => {
  it('busca en el log y verifica la cadena; solo lectura y solo para auditor', async () => {
    const r = await auditor.web.call('api', 'GET', '/v1/admin/audit?action=admin.&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.entries.length).toBeGreaterThan(0);
    expect(r.body.entries.every((e: { action: string }) => e.action.startsWith('admin.'))).toBe(true);
    const page2 = await auditor.web.call('api', 'GET', `/v1/admin/audit?limit=5&before=${r.body.nextBefore}`);
    expect(page2.body.entries[0].seq).toBeLessThan(r.body.nextBefore);
    const v = await auditor.web.call('api', 'POST', '/v1/admin/audit/verify');
    expect(v.body).toMatchObject({ intact: true, firstBrokenSeq: null });
    expect((await support.web.call('api', 'GET', '/v1/admin/audit')).status).toBe(403);
    expect((await auditor.web.call('api', 'GET', "/v1/admin/audit?action=x'%20OR%201=1")).status).toBe(400);
  });
});

describe('CORS', () => {
  it('solo el origen del panel recibe cabeceras CORS; sin cookies', async () => {
    const pre = (origin: string) => fetch(`${s.urls.api}/v1/admin/metrics`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,dpop' } });
    const ok = await pre(PANEL_ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(PANEL_ORIGIN);
    expect(ok.headers.get('access-control-allow-headers')).toContain('DPoP');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    const evil = await pre('https://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Panel web en un navegador real', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(() => browser?.close());

  it('passkey (autenticador virtual) + DPoP con WebCrypto: entra, ve solo sus secciones y verifica la auditoría; nada en almacenamiento', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(PANEL_ORIGIN);

    // La persona registra su passkey desde su sesión (en producción: la app; aquí: el navegador del panel).
    const u = await s.loggedIn();
    const opts = await u.d.call('auth', 'POST', '/v1/auth/passkeys/registration/options');
    const credential = await page.evaluate(async (o) => {
      const b = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
      const e = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const c = (await navigator.credentials.create({
        publicKey: { ...o, challenge: b(o.challenge), user: { ...o.user, id: b(o.user.id) }, excludeCredentials: [], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } },
      })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAttestationResponse;
      return { id: c.id, rawId: e(c.rawId), type: c.type, response: { clientDataJSON: e(r.clientDataJSON), attestationObject: e(r.attestationObject), transports: ['internal'] }, clientExtensionResults: {} };
    }, opts.body);
    expect((await u.d.call('auth', 'POST', '/v1/auth/passkeys/registration/verify', credential)).status).toBe(201);
    for (const role of ['auditor', 'route_manager']) {
      await fetch(`${s.urls.api}/v1/dev/admin/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: u.userId, role }) });
    }

    await page.click('#login-passkey');
    await page.waitForSelector('#shell:not(.hidden)');
    const menu = await page.locator('#menu a').allTextContents();
    expect(menu).toEqual(['Resumen', 'Taxi Ruta', 'Auditoría']);
    await page.waitForSelector('.stats');

    await page.click('a[data-view="auditoria"]');
    await page.click('text=Verificar ahora');
    await page.waitForSelector('text=/Íntegra: \\d+ entradas/');

    await page.click('a[data-view="rutas"]');
    await page.waitForSelector('text=R1');

    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(storage).toBe('{}{}');
    // Las peticiones del navegador van con DPoP (la clave nunca sale de WebCrypto): auth registró el inicio de sesión del panel.
    const login = await s.pool.query(`SELECT outcome FROM audit.audit_log WHERE action = 'admin.login' AND actor_user_id = $1`, [u.userId]);
    expect(login.rows.map((r) => r.outcome)).toContain('success');

    await page.reload();
    await page.waitForSelector('#login:not(.hidden)');
    expect(errors).toEqual([]);
  });
});
