import { eicarAsPng, sha256Hex, tinyPdf, tinyPng, validCedula, type HttpResult, type SimDevice } from '@intitaxi/testkit';

export interface SimEntry {
  id: string;
  label: string;
  role: string;
  integrity: string;
  phone?: string;
  userId?: string;
  device: SimDevice;
  /** Datos de la sesión del simulador (último challengeId, viaje activo, etc.). */
  data: Record<string, any>;
}

export interface ActionContext {
  services: Record<string, string>;
  devices: Map<string, SimEntry>;
  webauthn: { rpId: string; origin: string };
}

type Handler = (e: SimEntry, p: Record<string, any>, ctx: ActionContext) => Promise<HttpResult>;

const ok = (body: unknown): HttpResult => ({ status: 200, body });

/** Lugares de referencia en Guayaquil (coordenadas aproximadas, solo para el simulador). */
export const PLACES: Record<string, { lat: number; lng: number }> = {
  'Mall del Sol': { lat: -2.1547, lng: -79.8929 },
  'Malecón 2000': { lat: -2.1939, lng: -79.8803 },
  'Aeropuerto José Joaquín de Olmedo': { lat: -2.1574, lng: -79.8837 },
  'Terminal Terrestre': { lat: -2.1407, lng: -79.8885 },
  'Parque Centenario': { lat: -2.1896, lng: -79.8885 },
  'City Mall': { lat: -2.1405, lng: -79.9068 },
  'Riocentro Norte': { lat: -2.1357, lng: -79.9024 },
  'San Marino': { lat: -2.1700, lng: -79.8986 },
  Urdesa: { lat: -2.1745, lng: -79.9126 },
  Samborondón: { lat: -2.1460, lng: -79.8640 },
};

/** Acciones disponibles en el simulador. Cada módulo añade las suyas. */
export const actions: Record<string, Handler> = {
  // ----- Módulo 1: autenticación -----
  'otp.request': async (e, p) => {
    e.phone = p.phone;
    const r = await e.device.requestOtp(p.phone);
    if (r.status === 202) e.data.challengeId = r.body.challengeId;
    return r;
  },
  'otp.verify': async (e, p) => withMe(e, await e.device.verifyOtp(p.challengeId ?? e.data.challengeId, p.code)),
  refresh: (e) => e.device.refresh(),
  me: (e) => e.device.call('auth', 'GET', '/v1/me'),
  sessions: (e) => e.device.call('auth', 'GET', '/v1/auth/sessions'),
  'session.revoke': (e, p) => e.device.call('auth', 'DELETE', `/v1/auth/sessions/${p.sessionId}`),
  logout: async (e) => {
    const r = await e.device.call('auth', 'POST', '/v1/auth/logout');
    e.device.accessToken = '';
    return r;
  },
  'email.set': (e, p) => e.device.call('auth', 'POST', '/v1/me/email', { email: p.email }),
  'email.verify': (e, p) => e.device.call('auth', 'POST', '/v1/auth/email/verify', { token: p.token }, { auth: false }),
  'passkey.register': (e, _p, ctx) => e.device.registerPasskey(ctx.webauthn.rpId, ctx.webauthn.origin),
  'passkey.login': async (e, p, ctx) => {
    const from = ctx.devices.get(p.fromDevice);
    const authenticator = from?.device.passkey ?? e.device.passkey;
    if (!authenticator) return { status: 409, body: { title: 'Ningún dispositivo simulado tiene passkey' } };
    return withMe(e, await e.device.loginWithPasskey(authenticator));
  },
  'stepup.passkey': (e) => e.device.stepUpPasskey(),
  'devicekey.register': (e) => e.device.registerDeviceKey(),
  'devicekey.login': async (e) => withMe(e, await e.device.loginWithDeviceKey()),
  'stepup.email.options': async (e) => {
    const r = await e.device.stepUpEmailOptions();
    if (r.status === 200) e.data.stepUpChallenge = r.body.challenge;
    return r;
  },
  'stepup.email.verify': (e, p) => e.device.stepUpEmailVerify(p.code, e.data.stepUpChallenge),
  'phone.change': async (e, p) => {
    const r = await e.device.call('auth', 'POST', '/v1/auth/phone/change', { phone: p.phone });
    if (r.status === 202) e.data.phoneChallengeId = r.body.challengeId;
    return r;
  },
  'phone.confirm': (e, p) => e.device.call('auth', 'POST', '/v1/auth/phone/change/confirm', { challengeId: e.data.phoneChallengeId, code: p.code }),
  'token.forget': async (e) => {
    e.device.accessToken = '';
    return ok({ info: 'Token de acceso descartado en el simulador (la sesión sigue viva con el refresh token)' });
  },

  // ----- Módulo 2: consentimiento y verificación biométrica -----
  'consent.grant': async (e, p) => {
    const t = await e.device.call('api', 'GET', `/v1/consents/texts/${p.purpose}`, undefined, { auth: false });
    if (t.status !== 200) return t;
    return e.device.call('api', 'POST', '/v1/consents', { purpose: p.purpose, textVersion: t.body.version, textSha256: t.body.sha256 });
  },
  'consent.text': (e, p) => e.device.call('api', 'GET', `/v1/consents/texts/${p.purpose}`, undefined, { auth: false }),
  'consent.revoke': (e, p) => e.device.call('api', 'DELETE', `/v1/consents/${p.purpose}`),
  consents: (e) => e.device.call('api', 'GET', '/v1/consents'),
  'kyc.start': async (e, p) => {
    const r = await e.device.call('api', 'POST', '/v1/kyc/sessions', { kind: p.kind ?? 'full' });
    if (r.status === 201) e.data.kycSessionRef = String(r.body.sessionUrl).split('/').pop();
    return r;
  },
  'kyc.decide': async (e, p, ctx) => {
    if (!e.data.kycSessionRef) return { status: 409, body: { title: 'Primero inicia una verificación' } };
    const res = await fetch(`${ctx.services.api}/v1/dev/kyc/sessions/${e.data.kycSessionRef}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: p.status, documentNumber: p.documentNumber || undefined, givenNames: p.givenNames || undefined, familyNames: p.familyNames || undefined, reason: p.reason || undefined }),
    });
    return { status: res.status, body: { proveedorSimulado: await res.json(), nota: 'El proveedor envió el webhook firmado; la API consultó la decisión.' } };
  },
  'kyc.status': (e) => e.device.call('api', 'GET', '/v1/kyc/status'),
  'reverify.check': (e) => e.device.call('api', 'POST', '/v1/kyc/reverification/check'),

  // ----- Módulo 3: onboarding de conductores -----
  'driver.apply': (e, p) =>
    e.device.call('api', 'POST', '/v1/driver/application', { licenseNumber: p.licenseNumber, licenseCategory: p.licenseCategory, licenseExpiresOn: p.licenseExpiresOn }),
  'vehicle.add': async (e, p) => {
    const r = await e.device.call('api', 'POST', '/v1/driver/vehicles', { plate: p.plate, make: p.make, model: p.model, year: Number(p.year), color: p.color, seats: Number(p.seats) });
    if (r.status === 201) e.data.vehicleId = r.body.id;
    return r;
  },
  'doc.upload': async (e, p) => {
    const variants: Record<string, [Buffer, string]> = {
      valid: p.type === 'background_check' ? [tinyPdf(), 'application/pdf'] : [tinyPng(), 'image/png'],
      eicar: [eicarAsPng(), 'image/png'],
      fake_type: [tinyPdf(), 'image/png'],
      pdf_js: [tinyPdf(true), 'application/pdf'],
    };
    const [data, contentType] = variants[p.variant ?? 'valid']!;
    const vehicleId = ['registration', 'insurance'].includes(p.type) ? e.data.vehicleId : undefined;
    const u = await e.device.call('api', 'POST', '/v1/driver/documents/upload-url', { type: p.type, vehicleId, contentType, size: data.length, sha256: sha256Hex(data), expiresOn: p.expiresOn || '2030-01-01' });
    if (u.status !== 201) return u;
    const up = await e.device.upload(u.body.upload, data, contentType);
    if (up.status >= 300) return { status: up.status, body: { paso: 'subida al almacenamiento' } };
    return e.device.call('api', 'POST', `/v1/driver/documents/${u.body.documentId}/complete`);
  },
  'driver.submit': (e) => e.device.call('api', 'POST', '/v1/driver/application/submit'),
  'driver.profile': (e) => e.device.call('api', 'GET', '/v1/driver/profile'),

  // ----- Módulo 4: viajes -----
  'trip.quote': async (e, p) => {
    const r = await e.device.call('api', 'POST', '/v1/trips/quotes', { origin: PLACES[p.from], destination: PLACES[p.to], originLabel: p.from, destinationLabel: p.to });
    if (r.status === 200) e.data.quoteId = r.body.quoteId;
    return r;
  },
  'trip.request': async (e, p) => {
    if (!e.data.quoteId) return { status: 409, body: { title: 'Primero cotiza' } };
    const r = await e.device.call('api', 'POST', '/v1/trips', { quoteId: e.data.quoteId, paymentMethod: p.paymentMethod ?? 'cash', ...(p.extra ?? {}) }, { headers: { 'Idempotency-Key': `sim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` } });
    if (r.status === 201) e.data.tripId = r.body.id;
    return r;
  },
  'trip.request.group': async (e, p) => {
    if (!e.data.quoteId) return { status: 409, body: { title: 'Primero cotiza' } };
    const names = ['Luis', 'Rosa', 'Pedro', 'Carmen', 'Andrés', 'Valeria', 'Diego'];
    const companions: Record<string, unknown>[] = Array.from({ length: Number(p.adults ?? 0) }, (_, i) => ({
      givenNames: names[i % names.length], familyNames: 'Zambrano Ruiz', idType: 'cedula', idNumber: p.badCedula === 'true' && i === 0 ? '0912345678' : validCedula(),
      email: `${names[i % names.length]!.toLowerCase()}.${Math.random().toString(36).slice(2, 6)}@correo.test`, isMinor: false,
    }));
    if (p.minor === 'true') companions.push({ givenNames: 'Mateo', familyNames: 'Zambrano', idType: 'none', isMinor: true, guardian: p.thirdParty === 'true' ? 'primary' : 'requester' });
    const forThirdParty = p.thirdParty === 'true'
      ? { givenNames: 'Carmen', familyNames: 'Vera Loor', idType: 'cedula', idNumber: validCedula(), email: `carmen.${Math.random().toString(36).slice(2, 6)}@correo.test`, phone: p.thirdPhone || '0987654321' }
      : undefined;
    return actions['trip.request']!(e, { paymentMethod: 'cash', extra: { companions, forThirdParty } }, undefined as never);
  },
  'trip.parties': (e) => e.device.call('api', 'GET', `/v1/trips/${e.data.tripId}/parties`),
  'companion.save': (e, p) =>
    e.device.call('api', 'POST', '/v1/companions', { givenNames: p.givenNames, familyNames: p.familyNames, idType: 'cedula', idNumber: validCedula(), email: p.email, isMinor: false, alias: p.alias }),
  'companion.list': (e) => e.device.call('api', 'GET', '/v1/companions'),
  'subject.view': async (_e, p, ctx) => fetchJson(`${ctx.services.api}/v1/privacy/subject/${p.token}`, 'GET'),
  'subject.confirm': async (_e, p, ctx) => fetchJson(`${ctx.services.api}/v1/privacy/subject/${p.token}/confirm`, 'POST'),
  'subject.delete': async (_e, p, ctx) => fetchJson(`${ctx.services.api}/v1/privacy/subject/${p.token}/delete`, 'POST'),
  'trip.view': (e, p) => e.device.call('api', 'GET', `/v1/trips/${p.tripId || e.data.tripId}`),
  'trip.pin': (e) => e.device.call('api', 'GET', `/v1/trips/${e.data.tripId}/pin`),
  'trip.cancel': (e) => e.device.call('api', 'POST', `/v1/trips/${e.data.tripId}/cancel`, { reason: 'Cancelado desde el simulador' }),
  'trip.rate': (e, p) => e.device.call('api', 'POST', `/v1/trips/${p.tripId || e.data.tripId}/rating`, { stars: Number(p.stars), comment: p.comment || undefined }),
  'trip.contact': (e) => e.device.call('api', 'POST', `/v1/trips/${e.data.tripId}/contact-session`),
  'trip.history': (e) => e.device.call('api', 'GET', '/v1/trips'),
  'driver.online': async (e, p) => {
    const vehicleId = e.data.vehicleId ?? (await e.device.call('api', 'GET', '/v1/driver/profile')).body?.vehicles?.[0]?.id;
    const r = await e.device.call('api', 'POST', '/v1/driver/online', { vehicleId, location: PLACES[p.at] });
    if (r.status === 200) e.data.location = PLACES[p.at];
    return r;
  },
  'driver.offline': (e) => e.device.call('api', 'POST', '/v1/driver/offline'),
  'driver.location': (e, p) => e.device.call('api', 'POST', '/v1/driver/location', { location: PLACES[p.at], mock: p.mock === 'true' }),
  'driver.offers': (e) => e.device.call('api', 'GET', '/v1/driver/offers'),
  'driver.accept': async (e) => {
    const o = await e.device.call('api', 'GET', '/v1/driver/offers');
    if (!o.body?.length) return { status: 404, body: { title: 'No hay ofertas pendientes (duran 15 s)' } };
    const r = await e.device.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/accept`);
    if (r.status === 200) e.data.tripId = r.body.tripId;
    return r;
  },
  'driver.reject': async (e) => {
    const o = await e.device.call('api', 'GET', '/v1/driver/offers');
    if (!o.body?.length) return { status: 404, body: { title: 'No hay ofertas pendientes' } };
    return e.device.call('api', 'POST', `/v1/driver/offers/${o.body[0].offerId}/reject`);
  },
  'driver.arrived': (e) => e.device.call('api', 'POST', `/v1/driver/trips/${e.data.tripId}/arrived`),
  'driver.start': (e, p) => e.device.call('api', 'POST', `/v1/driver/trips/${e.data.tripId}/start`, { pin: p.pin }),
  'driver.complete': (e) => e.device.call('api', 'POST', `/v1/driver/trips/${e.data.tripId}/complete`),
  'driver.current': (e) => e.device.call('api', 'GET', '/v1/driver/trips/current'),

  // ----- Panel admin (módulo 3 y siguientes) -----
  'admin.me': (e) => e.device.call('api', 'GET', '/v1/admin/me'),
  'admin.drivers': (e, p) => e.device.call('api', 'GET', `/v1/admin/drivers?status=${p.status ?? 'under_review'}`),
  'admin.driver': (e, p) => e.device.call('api', 'GET', `/v1/admin/drivers/${p.driverId}`),
  'admin.doc.view': (e, p) => e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/documents/${p.documentId}/view-url`, { reason: p.reason }),
  'admin.doc.review': (e, p) => e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/documents/${p.documentId}/review`, { decision: p.decision, reason: p.reason || undefined }),
  'admin.docs.approveAll': async (e, p) => {
    const d = await e.device.call('api', 'GET', `/v1/admin/drivers/${p.driverId}`);
    if (d.status !== 200) return d;
    const results = [];
    for (const doc of d.body.documents) results.push((await e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/documents/${doc.id}/review`, { decision: 'approved' })).status);
    return { status: 200, body: { revisados: results.length, estados: results } };
  },
  'admin.driver.decide': (e, p) => e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/decision`, { decision: p.decision, reason: p.reason }),
  'admin.role.grant': (e, p) => e.device.call('api', 'POST', `/v1/admin/users/${p.userId}/roles`, { role: p.role }),

  // ----- Genérica: cualquier endpoint de cualquier servicio, firmada con DPoP -----
  call: (e, p) => e.device.call(p.service ?? 'api', p.method ?? 'GET', p.path, p.body),
};

async function fetchJson(url: string, method: string): Promise<HttpResult> {
  const r = await fetch(url, { method });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

/** Tras iniciar sesión, guarda el id de usuario (para usarlo en el panel admin y en los viajes). */
async function withMe(e: SimEntry, r: HttpResult): Promise<HttpResult> {
  if (r.status === 200) {
    const me = await e.device.call('auth', 'GET', '/v1/me');
    if (me.status === 200) e.userId = me.body.id;
  }
  return r;
}

export async function runAction(e: SimEntry, action: string, params: Record<string, any>, ctx: ActionContext): Promise<HttpResult> {
  const h = actions[action];
  if (!h) return { status: 400, body: { error: `acción desconocida: ${action}` } };
  try {
    return await h(e, params, ctx);
  } catch (err) {
    return { status: 599, body: { error: `fallo de red o del simulador: ${(err as Error).message}` } };
  }
}
