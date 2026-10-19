import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack } from '../src/stack.js';

const s = new Stack();
beforeAll(() => s.start(['auth', 'api']));
afterAll(() => s.stop());

async function consent(d: Awaited<ReturnType<Stack['device']>>, purpose = 'biometric_kyc') {
  const t = await d.call('api', 'GET', `/v1/consents/texts/${purpose}`, undefined, { auth: false });
  return d.call('api', 'POST', '/v1/consents', { purpose, textVersion: t.body.version, textSha256: t.body.sha256 });
}

async function decide(sessionUrl: string, body: Record<string, unknown>) {
  const ref = sessionUrl.split('/').pop();
  const r = await fetch(`${s.urls.api}/v1/dev/kyc/sessions/${ref}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function verifiedUser(doc = `09${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`) {
  const u = await s.loggedIn();
  expect((await consent(u.d)).status).toBe(201);
  const sess = await u.d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
  expect(sess.status).toBe(201);
  expect(await decide(sess.body.sessionUrl, { status: 'approved', documentNumber: doc, givenNames: 'Ana', familyNames: 'Pérez' })).toEqual({ webhookStatus: 200 });
  return { ...u, doc };
}

describe('Consentimiento biométrico', () => {
  it('muestra el texto vigente con versión y hash', async () => {
    const d = await s.device();
    const t = await d.call('api', 'GET', '/v1/consents/texts/biometric_kyc', undefined, { auth: false });
    expect(t.status).toBe(200);
    expect(t.body.body).toContain('NO guarda tus imágenes');
    expect(t.body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no permite iniciar la verificación sin consentimiento', async () => {
    const { d } = await s.loggedIn();
    const r = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
    expect(r.status).toBe(403);
    expect(r.body.title).toBe('consent_required');
  });

  it('rechaza consentir un texto desactualizado', async () => {
    const { d } = await s.loggedIn();
    const r = await d.call('api', 'POST', '/v1/consents', { purpose: 'biometric_kyc', textVersion: 1, textSha256: '0'.repeat(64) });
    expect(r.status).toBe(409);
  });

  it('el registro de consentimientos no se puede modificar', async () => {
    const { d } = await s.loggedIn();
    await consent(d);
    await expect(s.pool.query(`UPDATE kyc.consents SET action = 'grant'`)).rejects.toThrow(/solo inserción/);
  });
});

describe('Verificación de identidad (KYC)', () => {
  it('aprueba vía webhook firmado y guarda solo resultado, referencia y fecha (documento cifrado y enmascarado)', async () => {
    const { d, doc, userId } = await verifiedUser();
    const st = await d.call('api', 'GET', '/v1/kyc/status');
    expect(st.body.verification).toMatchObject({ status: 'approved', documentNumber: `${doc.slice(0, 2)}******${doc.slice(-2)}` });
    const { rows } = await s.pool.query('SELECT * FROM kyc.verifications WHERE user_id = $1', [userId]);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(doc);
    expect(raw).not.toContain('Pérez');
    const cols = Object.keys(rows[0]);
    expect(cols.some((c) => /image|photo|selfie|face|template|video/i.test(c))).toBe(false);
    expect(rows[0].provider_delete_after).not.toBeNull();
  });

  it('rechaza webhooks sin firma válida y no reabre una verificación ya decidida', async () => {
    const { d } = await s.loggedIn();
    await consent(d);
    const sess = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
    const ref = sess.body.sessionUrl.split('/').pop();
    const forged = await fetch(`${s.urls.api}/v1/webhooks/kyc/mock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HMAC-SIGNATURE': 'a'.repeat(64) },
      body: JSON.stringify({ sessionRef: ref }),
    });
    expect(forged.status).toBe(401);
    await decide(sess.body.sessionUrl, { status: 'declined', reason: 'liveness_failed' });
    await decide(sess.body.sessionUrl, { status: 'approved', documentNumber: '0912345678' });
    expect((await d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('declined');
  });

  it('marca para revisión manual un documento ya aprobado en otra cuenta', async () => {
    const first = await verifiedUser();
    const other = await s.loggedIn();
    await consent(other.d);
    const sess = await other.d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
    await decide(sess.body.sessionUrl, { status: 'approved', documentNumber: first.doc });
    expect((await other.d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('duplicate_review');
  });

  it('no aprueba sin número de documento', async () => {
    const { d } = await s.loggedIn();
    await consent(d);
    const sess = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
    await decide(sess.body.sessionUrl, { status: 'approved' });
    expect((await d.call('api', 'GET', '/v1/kyc/status')).body.verification.status).toBe('declined');
  });

  it('revocar el consentimiento invalida el resultado y programa el borrado inmediato en el proveedor', async () => {
    const { d, userId } = await verifiedUser();
    expect((await d.call('api', 'DELETE', '/v1/consents/biometric_kyc')).status).toBe(204);
    const st = await d.call('api', 'GET', '/v1/kyc/status');
    expect(st.body).toMatchObject({ consentGiven: false, verification: { status: 'revoked' } });
    const { rows } = await s.pool.query('SELECT provider_delete_after <= now() AS due FROM kyc.verifications WHERE user_id = $1', [userId]);
    expect(rows.every((r) => r.due)).toBe(true);
  });

  it('exige atestación y token DPoP para crear sesiones', async () => {
    const { d } = await s.loggedIn();
    await consent(d);
    const ticket = d.ticket;
    d.ticket = '';
    expect((await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' })).status).toBe(401);
    d.ticket = ticket;
    const token = d.accessToken;
    d.accessToken = '';
    expect((await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' })).status).toBe(401);
    d.accessToken = token;
  });
});

describe('Re-verificación del conductor', () => {
  it('exige selfie antes de conectarse y la satisface solo si es la misma persona', async () => {
    const { d, doc } = await verifiedUser();
    const first = await d.call('api', 'POST', '/v1/kyc/reverification/check');
    expect(first.body).toEqual({ required: true, reason: 'never_verified' });
    // Selfie de otra persona (cuenta prestada): se rechaza
    const s1 = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'driver_reverify' });
    await decide(s1.body.sessionUrl, { status: 'approved', documentNumber: '1712345678' });
    expect((await d.call('api', 'POST', '/v1/kyc/reverification/check')).body.required).toBe(true);
    // La misma persona: se satisface
    const s2 = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'driver_reverify' });
    await decide(s2.body.sessionUrl, { status: 'approved', documentNumber: doc });
    expect((await d.call('api', 'POST', '/v1/kyc/reverification/check')).body).toEqual({ required: false });
  });

  it('vuelve a exigirla desde otro dispositivo', async () => {
    const { d, doc, phone } = await verifiedUser();
    await d.call('api', 'POST', '/v1/kyc/reverification/check');
    const sess = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'driver_reverify' });
    await decide(sess.body.sessionUrl, { status: 'approved', documentNumber: doc });
    const other = await s.device();
    const r = await other.requestOtp(phone.local);
    await other.verifyOtp(r.body.challengeId, await s.lastCode(phone.e164));
    expect((await other.call('api', 'POST', '/v1/kyc/reverification/check')).body).toEqual({ required: true, reason: 'new_device' });
  });
});
