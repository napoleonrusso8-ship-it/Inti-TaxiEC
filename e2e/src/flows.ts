import { SimDevice, sha256Hex, tinyPdf, tinyPng } from '@intitaxi/testkit';
import type { Stack } from './stack.js';

/** Flujos reutilizables entre módulos. */
export async function grantConsent(d: SimDevice, purpose = 'biometric_kyc') {
  const t = await d.call('api', 'GET', `/v1/consents/texts/${purpose}`, undefined, { auth: false });
  return d.call('api', 'POST', '/v1/consents', { purpose, textVersion: t.body.version, textSha256: t.body.sha256 });
}

export async function decideKyc(s: Stack, sessionUrl: string, body: Record<string, unknown>) {
  const ref = sessionUrl.split('/').pop();
  const r = await fetch(`${s.urls.api}/v1/dev/kyc/sessions/${ref}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export const randomCedula = () => `09${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
export const randomPlate = () => `G${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}-${1000 + Math.floor(Math.random() * 9000)}`;

/** Usuario con identidad verificada (y re-verificación de conductor al día si es conductor). */
export async function verifiedUser(s: Stack, role: 'passenger' | 'driver' = 'passenger', doc = randomCedula()) {
  const u = await s.loggedIn(role);
  await grantConsent(u.d);
  const sess = await u.d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'full' });
  if (sess.status !== 201) throw new Error(`kyc ${sess.status} ${JSON.stringify(sess.body)}`);
  await decideKyc(s, sess.body.sessionUrl, { status: 'approved', documentNumber: doc, givenNames: 'Juan Carlos', familyNames: 'Mora Vera' });
  return { ...u, doc };
}

/** Usuario con passkey + rol de administración + sesión en el panel (navegador). */
export async function adminSession(s: Stack, role: string) {
  const u = await s.loggedIn();
  const reg = await u.d.registerPasskey('localhost', s.urls.auth!);
  if (reg.status !== 201) throw new Error(`passkey ${reg.status} ${JSON.stringify(reg.body)}`);
  await fetch(`${s.urls.api}/v1/dev/admin/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: u.userId, role }) });
  const web = await SimDevice.createWeb({ services: s.urls });
  const login = await web.loginAdmin(u.d.passkey!);
  if (login.status !== 200) throw new Error(`admin login ${login.status} ${JSON.stringify(login.body)}`);
  return { web, userId: u.userId };
}

export async function uploadDoc(d: SimDevice, type: string, opts: { vehicleId?: string; data?: Buffer; contentType?: string; expiresOn?: string } = {}) {
  const data = opts.data ?? (type === 'background_check' ? tinyPdf() : tinyPng());
  const contentType = opts.contentType ?? (type === 'background_check' ? 'application/pdf' : 'image/png');
  const u = await d.call('api', 'POST', '/v1/driver/documents/upload-url', {
    type, vehicleId: opts.vehicleId, contentType, size: data.length, sha256: sha256Hex(data), expiresOn: opts.expiresOn ?? '2030-01-01',
  });
  if (u.status !== 201) return u;
  const up = await d.upload(u.body.upload, data, contentType);
  if (up.status !== 200 && up.status !== 204) return up;
  return d.call('api', 'POST', `/v1/driver/documents/${u.body.documentId}/complete`);
}

/** Conductor con solicitud completa enviada (pendiente de revisión). */
export async function submittedDriver(s: Stack, seats = 4) {
  const u = await verifiedUser(s, 'driver');
  const app = await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-12-31' });
  if (app.status !== 201) throw new Error(`apply ${app.status} ${JSON.stringify(app.body)}`);
  const v = await u.d.call('api', 'POST', '/v1/driver/vehicles', { plate: randomPlate(), make: 'Chevrolet', model: 'Aveo', year: 2022, color: 'Amarillo', seats });
  if (v.status !== 201) throw new Error(`vehicle ${v.status} ${JSON.stringify(v.body)}`);
  for (const t of ['license', 'background_check']) await uploadDoc(u.d, t);
  for (const t of ['registration', 'insurance']) await uploadDoc(u.d, t, { vehicleId: v.body.id });
  const sub = await u.d.call('api', 'POST', '/v1/driver/application/submit');
  if (sub.status !== 200) throw new Error(`submit ${sub.status} ${JSON.stringify(sub.body)}`);
  return { ...u, vehicleId: v.body.id as string, plate: v.body.plate as string };
}

/** Conductor aprobado por un revisor (todos los documentos revisados). */
export async function approvedDriver(s: Stack, reviewer?: SimDevice, seats = 4) {
  const drv = await submittedDriver(s, seats);
  const admin = reviewer ?? (await adminSession(s, 'driver_reviewer')).web;
  const detail = await admin.call('api', 'GET', `/v1/admin/drivers/${drv.userId}`);
  for (const doc of detail.body.documents) {
    await admin.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/documents/${doc.id}/review`, { decision: 'approved' });
  }
  const dec = await admin.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/decision`, { decision: 'approve', reason: 'Documentos en regla' });
  if (dec.status !== 200) throw new Error(`approve ${dec.status} ${JSON.stringify(dec.body)}`);
  return { ...drv, admin };
}
