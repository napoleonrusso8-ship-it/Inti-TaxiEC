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
export async function submittedDriver(s: Stack, seats = 4, vehicleType: 'taxi' | 'van' | 'tow' | 'rental' = 'taxi', rentalCategory = 'auto') {
  const u = await verifiedUser(s, 'driver');
  const app = await u.d.call('api', 'POST', '/v1/driver/application', { licenseNumber: `L${u.doc}`, licenseCategory: 'C', licenseExpiresOn: '2029-12-31' });
  if (app.status !== 201) throw new Error(`apply ${app.status} ${JSON.stringify(app.body)}`);
  const v = await u.d.call('api', 'POST', '/v1/driver/vehicles', { plate: randomPlate(), make: vehicleType === 'van' ? 'Hyundai' : 'Chevrolet', model: vehicleType === 'van' ? 'H1' : 'Aveo', year: 2022, color: vehicleType === 'van' ? 'Blanco' : 'Amarillo', seats, vehicleType, ...(vehicleType === 'rental' ? { rentalCategory } : {}) });
  if (v.status !== 201) throw new Error(`vehicle ${v.status} ${JSON.stringify(v.body)}`);
  for (const t of ['license', 'background_check']) await uploadDoc(u.d, t);
  for (const t of ['registration', 'insurance']) await uploadDoc(u.d, t, { vehicleId: v.body.id });
  const sub = await u.d.call('api', 'POST', '/v1/driver/application/submit');
  if (sub.status !== 200) throw new Error(`submit ${sub.status} ${JSON.stringify(sub.body)}`);
  return { ...u, vehicleId: v.body.id as string, plate: v.body.plate as string };
}

/** Conductor aprobado por un revisor (todos los documentos revisados). */
export async function approvedDriver(s: Stack, reviewer?: SimDevice, seats = 4, vehicleType: 'taxi' | 'van' | 'tow' | 'rental' = 'taxi', rentalCategory = 'auto') {
  const drv = await submittedDriver(s, seats, vehicleType, rentalCategory);
  const admin = reviewer ?? (await adminSession(s, 'driver_reviewer')).web;
  const detail = await admin.call('api', 'GET', `/v1/admin/drivers/${drv.userId}`);
  for (const doc of detail.body.documents) {
    // La matrícula se aprueba confirmando los asientos que indica.
    const v = detail.body.vehicles.find((x: { id: string }) => x.id === doc.vehicleId);
    await admin.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/documents/${doc.id}/review`, { decision: 'approved', ...(doc.type === 'registration' ? { confirmedSeats: v.seats_passenger } : {}) });
  }
  const dec = await admin.call('api', 'POST', `/v1/admin/drivers/${drv.userId}/decision`, { decision: 'approve', reason: 'Documentos en regla' });
  if (dec.status !== 200) throw new Error(`approve ${dec.status} ${JSON.stringify(dec.body)}`);
  return { ...drv, admin };
}

export const MALL_DEL_SOL = { lat: -2.1547, lng: -79.8929 };
export const MALECON = { lat: -2.1939, lng: -79.8803 };

/** Selfie del conductor si la política la exige (misma cédula = misma persona). */
export async function freshIdentity(s: Stack, d: SimDevice, doc: string) {
  const chk = await d.call('api', 'POST', '/v1/kyc/reverification/check');
  if (!chk.body.required) return;
  const sess = await d.call('api', 'POST', '/v1/kyc/sessions', { kind: 'driver_reverify' });
  await decideKyc(s, sess.body.sessionUrl, { status: 'approved', documentNumber: doc });
}

/** Conductor aprobado y conectado cerca de un punto. */
export async function onlineDriver(s: Stack, at = MALL_DEL_SOL, seats = 4, reviewer?: SimDevice) {
  const drv = await approvedDriver(s, reviewer, seats);
  await freshIdentity(s, drv.d, drv.doc);
  const on = await drv.d.call('api', 'POST', '/v1/driver/online', { vehicleId: drv.vehicleId, location: at });
  if (on.status !== 200) throw new Error(`online ${on.status} ${JSON.stringify(on.body)}`);
  return drv;
}

let idem = 0;
export const idemKey = () => `e2e-${Date.now()}-${++idem}-xxxxxxxx`;

export async function requestTrip(d: SimDevice, extra: Record<string, unknown> = {}, from = MALL_DEL_SOL, to = MALECON) {
  const q = await d.call('api', 'POST', '/v1/trips/quotes', { origin: from, destination: to, originLabel: 'Mall del Sol', destinationLabel: 'Malecón 2000' });
  if (q.status !== 200) throw new Error(`quote ${q.status} ${JSON.stringify(q.body)}`);
  return d.call('api', 'POST', '/v1/trips', { quoteId: q.body.quoteId, paymentMethod: 'cash', ...extra }, { headers: { 'Idempotency-Key': idemKey() } });
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await fn();
  }
  return v;
}

/** Viaje completo hasta "en curso" (solicitado → aceptado → llegó → PIN). */
export async function startedTrip(s: Stack, opts: { passenger?: { d: SimDevice; userId: string }; extra?: Record<string, unknown> } = {}) {
  // Aísla la prueba: los conductores de pruebas anteriores dejan de estar disponibles para emparejar.
  await s.redis.del('drivers:available');
  const drv = await onlineDriver(s);
  const p = opts.passenger ?? (await s.loggedIn());
  const t = await requestTrip(p.d, opts.extra ?? {});
  if (t.status !== 201) throw new Error(`trip ${t.status} ${JSON.stringify(t.body)}`);
  await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
  await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
  const pin = await p.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`);
  const st = await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin: pin.body.pin });
  if (st.status !== 200) throw new Error(`start ${st.status} ${JSON.stringify(st.body)}`);
  return { drv, p, tripId: t.body.id as string };
}

/** Espera la oferta de UN viaje concreto (otras pruebas pueden tener viajes buscando cerca). */
export async function offerFor(d: SimDevice, tripId: string, ms = 8000): Promise<string> {
  const r = await waitFor(() => d.call('api', 'GET', '/v1/driver/offers'), (x) => x.body.some((o: { tripId: string }) => o.tripId === tripId), ms);
  const o = r.body.find((x: { tripId: string }) => x.tripId === tripId);
  if (!o) throw new Error(`sin oferta para ${tripId}`);
  return o.offerId;
}

/** Viaje completado de punta a punta con el medio de pago indicado. */
export async function completedTrip(s: Stack, opts: { at: { lat: number; lng: number }; passenger?: { d: SimDevice; userId: string }; payment?: Record<string, unknown>; driver?: Awaited<ReturnType<typeof onlineDriver>>; reviewer?: SimDevice }) {
  if (!opts.driver) await s.redis.del('drivers:available');
  const drv = opts.driver ?? (await onlineDriver(s, opts.at, 4, opts.reviewer));
  const p = opts.passenger ?? (await s.loggedIn());
  const t = await requestTrip(p.d, opts.payment ?? {}, opts.at, MALECON);
  if (t.status !== 201) return { drv, p, trip: t };
  await drv.d.call('api', 'POST', `/v1/driver/offers/${await offerFor(drv.d, t.body.id)}/accept`);
  await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/arrived`);
  const pin = (await p.d.call('api', 'GET', `/v1/trips/${t.body.id}/pin`)).body.pin;
  await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/start`, { pin });
  // Simula el recorrido para que no parezca un viaje fantasma
  await drv.d.call('api', 'POST', '/v1/driver/location', { location: { lat: opts.at.lat + 0.0001, lng: opts.at.lng } });
  await drv.d.call('api', 'POST', `/v1/driver/trips/${t.body.id}/complete`);
  return { drv, p, trip: t };
}
