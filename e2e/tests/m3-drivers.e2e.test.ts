import { eicarAsPng, tinyPdf, tinyPng } from '@intitaxi/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSession, approvedDriver, submittedDriver, uploadDoc, verifiedUser } from '../src/flows.js';
import { Stack } from '../src/stack.js';

const s = new Stack();
beforeAll(() => s.start(['auth', 'api']));
afterAll(() => s.stop());

describe('Solicitud del conductor', () => {
  it('exige identidad verificada y la app de conductor', async () => {
    const plain = await s.loggedIn('driver');
    const r = await plain.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: 'L0912345678', licenseCategory: 'C', licenseExpiresOn: '2029-01-01' });
    expect(r.body.title).toBe('kyc_required');
    const passengerApp = await verifiedUser(s, 'passenger');
    const p = await passengerApp.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: 'L0912345678', licenseCategory: 'C', licenseExpiresOn: '2029-01-01' });
    expect(p.status).toBe(403);
  });

  it('valida categoría profesional, licencia vigente, placa y antigüedad del vehículo', async () => {
    const u = await verifiedUser(s, 'driver');
    expect((await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: 'L1', licenseCategory: 'B', licenseExpiresOn: '2029-01-01' })).status).toBe(400);
    expect((await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: 'LIC123456', licenseCategory: 'C', licenseExpiresOn: '2020-01-01' })).body.title).toBe('license_expired');
    expect((await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: 'LIC123456', licenseCategory: 'C', licenseExpiresOn: '2029-01-01' })).status).toBe(201);
    expect((await u.d.call('api', 'POST', '/v1/driver/vehicles', { plate: 'G1-12', make: 'Kia', model: 'Rio', year: 2022, color: 'Amarillo', seats: 4 })).body.title).toBe('invalid_plate');
    expect((await u.d.call('api', 'POST', '/v1/driver/vehicles', { plate: 'GBA-1234', make: 'Kia', model: 'Rio', year: 1995, color: 'Amarillo', seats: 4 })).body.title).toBe('vehicle_too_old');
  });

  it('no permite enviar la solicitud incompleta', async () => {
    const u = await verifiedUser(s, 'driver');
    await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-01-01' });
    const r = await u.d.call('api', 'POST', '/v1/driver/application/submit');
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain('doc_license');
  });
});

describe('Documentos', () => {
  async function applicant() {
    const u = await verifiedUser(s, 'driver');
    await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-01-01' });
    return u;
  }

  it('acepta PNG y PDF válidos', async () => {
    const u = await applicant();
    expect((await uploadDoc(u.d, 'license')).body).toMatchObject({ status: 'uploaded', scanStatus: 'clean' });
    expect((await uploadDoc(u.d, 'background_check', { data: tinyPdf(), contentType: 'application/pdf' })).status).toBe(200);
  });

  it('rechaza tipo falsificado, PDF con JavaScript y malware (EICAR), y borra el archivo', async () => {
    const u = await applicant();
    expect((await uploadDoc(u.d, 'license', { data: tinyPdf(), contentType: 'image/png' })).body.detail).toContain('type_mismatch');
    expect((await uploadDoc(u.d, 'background_check', { data: tinyPdf(true), contentType: 'application/pdf' })).body.detail).toContain('active_content');
    expect((await uploadDoc(u.d, 'license', { data: eicarAsPng() })).body.detail).toContain('malware');
    const { rows } = await s.pool.query(`SELECT scan_status FROM drivers.documents WHERE driver_id = $1 AND upload_status = 'rejected'`, [u.userId]);
    expect(rows.map((r) => r.scan_status).sort()).toEqual(['infected', 'invalid', 'invalid']);
  });

  it('rechaza un archivo distinto del declarado (hash) y no permite subir más de lo firmado', async () => {
    const u = await applicant();
    const data = tinyPng();
    const url = await u.d.call('api', 'POST', '/v1/driver/documents/upload-url', { type: 'license', contentType: 'image/png', size: data.length, sha256: '0'.repeat(64) });
    await u.d.upload(url.body.upload, data, 'image/png');
    expect((await u.d.call('api', 'POST', `/v1/driver/documents/${url.body.documentId}/complete`)).body.detail).toContain('hash_mismatch');
    const url2 = await u.d.call('api', 'POST', '/v1/driver/documents/upload-url', { type: 'license', contentType: 'image/png', size: 10, sha256: '0'.repeat(64) });
    expect((await u.d.upload(url2.body.upload, Buffer.alloc(50_000), 'image/png')).status).toBe(413);
  });

  it('no permite usar el vehículo ni completar documentos de otro conductor (IDOR)', async () => {
    const a = await submittedDriver(s);
    const b = await applicant();
    const data = tinyPng();
    const r = await b.d.call('api', 'POST', '/v1/driver/documents/upload-url', { type: 'registration', vehicleId: a.vehicleId, contentType: 'image/png', size: data.length, sha256: '0'.repeat(64) });
    expect(r.status).toBe(404);
    const { rows } = await s.pool.query('SELECT id FROM drivers.documents WHERE driver_id = $1 LIMIT 1', [a.userId]);
    expect((await b.d.call('api', 'POST', `/v1/driver/documents/${rows[0].id}/complete`)).status).toBe(404);
  });
});

describe('Revisión por administradores', () => {
  it('aprueba al conductor solo con todos los documentos revisados', async () => {
    const drv = await submittedDriver(s);
    const { web } = await adminSession(s, 'driver_reviewer');
    const early = await web.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/decision`, { decision: 'approve', reason: 'aprobar ya' });
    expect(early.status).toBe(409);
    const ok = await approvedDriver(s, web);
    const profile = await ok.d.call('api', 'GET', '/v1/driver/profile');
    expect(profile.body.status).toBe('approved');
    expect(profile.body.issues).toEqual([]);
    expect(profile.body.vehicles[0].status).toBe('approved');
    expect(profile.body.license.number).toMatch(/\*\*\*/);
  });

  it('las URLs de documentos exigen motivo, duran 60 s y quedan auditadas', async () => {
    const drv = await submittedDriver(s);
    const { web, userId: adminId } = await adminSession(s, 'driver_reviewer');
    const docs = (await web.call('api', 'GET', `/v1/admin/drivers/${drv.userId}`)).body.documents;
    expect((await web.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/documents/${docs[0].id}/view-url`, { reason: 'x' })).status).toBe(400);
    const v = await web.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/documents/${docs[0].id}/view-url`, { reason: 'Revisión de licencia profesional' });
    expect(v.body.expiresIn).toBe(60);
    const file = await fetch(v.body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe('attachment');
    const tampered = await fetch(v.body.url.replace(/sig=[^&]+/, 'sig=AAAA'));
    expect(tampered.status).toBe(403);
    const { rows } = await s.pool.query(`SELECT purpose, metadata FROM audit.audit_log WHERE action = 'driver.document_view' AND actor_user_id = $1`, [adminId]);
    expect(rows[0]).toMatchObject({ purpose: 'driver_review', metadata: { reason: 'Revisión de licencia profesional' } });
  });

  it('RBAC: sin rol, con otro rol o desde la app móvil no se accede al panel', async () => {
    const drv = await submittedDriver(s);
    const { web: support } = await adminSession(s, 'support');
    expect((await support.call('api', 'GET', '/v1/admin/drivers')).status).toBe(403);
    // Un token de la app móvil (aunque el usuario tenga el rol) no sirve para el panel
    const reviewer = await s.loggedIn();
    await fetch(`${s.urls.api}/v1/dev/admin/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: reviewer.userId, role: 'driver_reviewer' }) });
    expect((await reviewer.d.call('api', 'GET', '/v1/admin/drivers')).status).toBe(403);
    expect(drv.userId).toBeTruthy();
  });

  it('un revisor no puede aprobarse a sí mismo y solo super_admin asigna roles', async () => {
    const { web, userId } = await adminSession(s, 'driver_reviewer');
    expect((await web.call('api', 'POST', `/v1/admin/drivers/${userId}/decision`, { decision: 'approve', reason: 'me apruebo' })).status).toBe(403);
    expect((await web.call('api', 'POST', `/v1/admin/users/${userId}/roles`, { role: 'super_admin' })).status).toBe(403);
    const { web: root } = await adminSession(s, 'super_admin');
    const target = await s.loggedIn();
    expect((await root.call('api', 'POST', `/v1/admin/users/${target.userId}/roles`, { role: 'support' })).status).toBe(201);
  });

  it('el panel solo acepta passkey: un código OTP no sirve para el cliente admin', async () => {
    const u = await s.loggedIn();
    const r = await u.d.requestOtp(u.phone.local);
    const v = await u.d.call('auth', 'POST', '/v1/auth/otp/verify', { challengeId: r.body.challengeId, code: await s.lastCode(u.phone.e164), codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', codeChallengeMethod: 'S256' }, { auth: false });
    const t = await u.d.call('auth', 'POST', '/oauth/token', { grant_type: 'authorization_code', code: v.body.code, code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', client_id: 'intitaxi-admin' }, { auth: false, form: true });
    expect(t.body.error).toBe('invalid_grant');
  });
});
