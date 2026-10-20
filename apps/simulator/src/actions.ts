import { eicarAsPng, sha256Hex, tinyPdf, tinyPng, validCedula, type HttpResult, type SimDevice, type SimSocket } from '@intitaxi/testkit';

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
  /** App única: con la sesión de pasajero obtiene la de socio sin otro SMS (RFC 8693) y la prueba en la API de socio. */
  'token.exchange': async (e) => {
    const x = await e.device.tokenExchange('intitaxi-driver');
    if (x.status !== 200) return x;
    const profile = await e.device.call('api', 'GET', '/v1/driver/profile', undefined, { accessToken: x.body.access_token });
    return ok({ info: 'Sesión de socio creada en este dispositivo (misma clave DPoP, mismo nivel de autenticación)', expiresIn: x.body.expires_in, perfilDeSocio: { status: profile.status, body: profile.body } });
  },
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
    e.device.call(
      'api',
      'POST',
      '/v1/driver/application',
      p.partnerKind === 'rental_company'
        ? { partnerKind: p.partnerKind, company: { businessName: p.businessName, ruc: p.ruc } }
        : { partnerKind: p.partnerKind || 'taxi_driver', licenseNumber: p.licenseNumber, licenseCategory: p.licenseCategory, licenseExpiresOn: p.licenseExpiresOn },
    ),
  'vehicle.add': async (e, p) => {
    const r = await e.device.call('api', 'POST', '/v1/driver/vehicles', { plate: p.plate, make: p.make, model: p.model, year: Number(p.year), color: p.color, seats: Number(p.seats), vehicleType: p.vehicleType || 'taxi', ...(p.vehicleType === 'rental' ? { rentalCategory: p.rentalCategory || 'auto' } : {}) });
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
    let paymentMethodId: string | undefined;
    if (p.paymentMethod === 'card') {
      const cards = await e.device.call('api', 'GET', '/v1/payment-methods');
      paymentMethodId = cards.body?.find((c: { status: string }) => c.status === 'active')?.id;
    }
    const r = await e.device.call('api', 'POST', '/v1/trips', { quoteId: e.data.quoteId, paymentMethod: p.paymentMethod ?? 'cash', paymentMethodId, ...(p.ellxsOnly === 'true' ? { ellxsOnly: true } : {}), ...(p.extra ?? {}) }, { headers: { 'Idempotency-Key': `sim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` } });
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

  // ----- Inclusión: Modo Ellxs (mujeres y personas LGBTI) -----
  prefs: (e) => e.device.call('api', 'GET', '/v1/me/preferences'),
  /** Activar exige antes el consentimiento "ellxs" (dato sensible); desactivar borra la autodeclaración. */
  'prefs.ellxs': (e, p) => e.device.call('api', 'PUT', '/v1/me/preferences', { ellxsMember: p.on === 'true' }),
  'driver.ellxs.request': (e) => e.device.call('api', 'POST', '/v1/driver/ellxs/request'),
  'admin.ellxs.pending': (e) => e.device.call('api', 'GET', '/v1/admin/drivers/ellxs/pending'),
  'admin.ellxs.decide': (e, p) => e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/ellxs`, { approve: p.approve === 'true' }),

  // ----- Módulo 6: tiempo real -----
  'driver.drive': async (e) => {
    const cur = await e.device.call('api', 'GET', '/v1/driver/trips/current');
    if (!cur.body) return { status: 409, body: { title: 'No tienes un viaje activo' } };
    const target = ['accepted', 'arrived'].includes(cur.body.status) ? cur.body.origin : cur.body.destination;
    const from = e.data.location ?? cur.body.driverLocation ?? target;
    clearInterval(e.data.driveTimer);
    // Avanza ~80 m cada 2 s (40 m/s máx., bajo el umbral de salto imposible).
    const steps = Math.max(1, Math.ceil(Math.hypot((target.lat - from.lat) * 111_000, (target.lng - from.lng) * 111_000) / 80));
    let i = 0;
    e.data.driveTimer = setInterval(async () => {
      i += 1;
      const p = { lat: from.lat + ((target.lat - from.lat) * i) / steps, lng: from.lng + ((target.lng - from.lng) * i) / steps };
      e.data.location = p;
      await e.device.call('api', 'POST', '/v1/driver/location', { location: p }).catch(() => {});
      if (i >= steps) clearInterval(e.data.driveTimer);
    }, 2000);
    return ok({ info: `Conduciendo hacia ${['accepted', 'arrived'].includes(cur.body.status) ? 'el punto de recogida' : 'el destino'} en ${steps} pasos (~${steps * 2} s)` });
  },
  'driver.stop': async (e) => {
    clearInterval(e.data.driveTimer);
    return ok({ info: 'Detenido' });
  },
  'trip.share': (e) => e.device.call('api', 'POST', `/v1/trips/${e.data.tripId}/share-links`),
  'rt.listen': async (e) => {
    const sock = (e.data.socket as SimSocket | undefined) ?? (await e.device.openSocket());
    e.data.socket = sock;
    const tripId = e.data.tripId;
    if (tripId) sock.send({ type: 'subscribe', channel: `trip:${tripId}` });
    await new Promise((r) => setTimeout(r, 300));
    return ok({ conectado: !sock.closed, suscrito: tripId ? `trip:${tripId}` : 'sin viaje', mensajes: sock.messages.slice(-5) });
  },
  'rt.messages': async (e) => {
    const sock = e.data.socket as SimSocket | undefined;
    return ok(sock ? { cerrado: sock.closed, mensajes: sock.messages.slice(-30) } : { info: 'Primero "Escuchar en vivo"' });
  },
  'chat.send': async (e, p) => {
    const sock = e.data.socket as SimSocket | undefined;
    if (!sock) return { status: 409, body: { title: 'Primero "Escuchar en vivo"' } };
    sock.send({ type: 'chat', tripId: e.data.tripId, text: p.text });
    await new Promise((r) => setTimeout(r, 300));
    return ok({ enviado: p.text, ultimos: sock.messages.filter((m) => m.type === 'chat').slice(-5) });
  },

  // ----- Módulo 7: pagos -----
  'card.add': async (e, p) => {
    const r = await e.device.call('api', 'POST', '/v1/payment-methods', { cardToken: `${p.kind}_${Math.random().toString(36).slice(2, 8)}` });
    if (r.body?.threeDsUrl) e.data.threeDsRef = String(r.body.threeDsUrl).split('/').pop();
    return r;
  },
  'card.3ds': async (e, p, ctx) => {
    if (!e.data.threeDsRef) return { status: 409, body: { title: 'No hay un desafío 3-D Secure pendiente' } };
    return fetchJson(`${ctx.services.api}/v1/dev/payments/3ds/${e.data.threeDsRef}/complete`, 'POST', { result: p.result });
  },
  'card.list': (e) => e.device.call('api', 'GET', '/v1/payment-methods'),
  'trip.receipt': (e, p) => e.device.call('api', 'GET', `/v1/trips/${p.tripId || e.data.tripId}/receipt`),
  wallet: (e) => e.device.call('api', 'GET', '/v1/wallet'),
  'payment.retry': async (e) => {
    const cards = (await e.device.call('api', 'GET', '/v1/payment-methods')).body ?? [];
    const card = [...cards].reverse().find((c: { status: string }) => c.status === 'active');
    const hist = await e.device.call('api', 'GET', `/v1/trips/${e.data.tripId}/receipt`);
    if (!hist.body?.receiptId || !card) return { status: 409, body: { title: 'Necesitas un cobro rechazado y otra tarjeta activa' } };
    return e.device.call('api', 'POST', `/v1/payments/${hist.body.receiptId}/retry`, { paymentMethodId: card.id });
  },
  'driver.earnings': (e) => e.device.call('api', 'GET', '/v1/driver/earnings'),
  'driver.payoutAccount': (e, p) =>
    e.device.call('api', 'POST', '/v1/driver/payout-accounts', { bankCode: p.bankCode, accountType: 'savings', accountNumber: p.accountNumber, holderName: p.holderName, holderCedula: p.holderCedula }),
  'driver.payout': (e, p) => e.device.call('api', 'POST', '/v1/driver/payouts', { amountCents: Number(p.amountCents) }, { headers: { 'Idempotency-Key': `sim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}` } }),
  'admin.wallet.credit': (e, p) => e.device.call('api', 'POST', `/v1/admin/wallets/${p.userId}/credit`, { amountCents: Number(p.amountCents), reason: p.reason }),
  'admin.refund': (e, p) => e.device.call('api', 'POST', `/v1/admin/payments/${p.paymentId}/refund`, { amountCents: Number(p.amountCents), to: p.to, reason: p.reason }),
  'admin.fraud': (e) => e.device.call('api', 'GET', '/v1/admin/fraud/signals'),
  'admin.payouts': (e, p) => e.device.call('api', 'GET', `/v1/admin/payouts?status=${p.status}`),
  'admin.payout.decide': (e, p) => e.device.call('api', 'POST', `/v1/admin/payouts/${p.payoutId}/decision`, { decision: p.decision, reason: p.reason }),

  // ----- Módulo 8: seguridad del viaje -----
  'trusted.add': (e, p) => e.device.call('auth', 'POST', '/v1/me/trusted-contacts', { name: p.name, phone: p.phone }),
  'trusted.list': (e) => e.device.call('auth', 'GET', '/v1/me/trusted-contacts'),
  'pins.set': (e, p) => e.device.call('sos', 'PUT', '/v1/me/safety-pins', { pin: p.pin, duressPin: p.duressPin, currentPin: p.currentPin || undefined }),
  'sos.activate': async (e) => {
    const loc = e.data.location ?? PLACES['Mall del Sol'];
    const r = await e.device.call('sos', 'POST', '/v1/sos', { tripId: e.data.tripId, location: loc });
    if (r.status === 201) e.data.incidentId = r.body.incidentId;
    return r;
  },
  'sos.status': (e) => e.device.call('sos', 'GET', `/v1/sos/${e.data.incidentId}`),
  'sos.cancel': (e, p) => e.device.call('sos', 'POST', `/v1/sos/${e.data.incidentId}/cancel`, { pin: p.pin }),
  'sos.accident': async (e) => {
    const r = await e.device.call('sos', 'POST', `/v1/driver/trips/${e.data.tripId}/accident`, { location: e.data.location ?? PLACES['Mall del Sol'] });
    if (r.status === 201) e.data.incidentId = r.body.incidentId;
    return r;
  },
  'sos.link': async (_e, p, ctx) => fetchJson(`${ctx.services.sos}/v1/track/${p.token}/sos`, 'POST', { location: PLACES['Parque Centenario'] }),
  'ecu911.log': async (_e, _p, ctx) => fetchJson(`${ctx.services.sos}/v1/dev/ecu911`, 'GET'),
  'admin.incidents': (e, p) => e.device.call('sos', 'GET', `/v1/admin/incidents?status=${p.status}`),
  'admin.incident': (e, p) => e.device.call('sos', 'GET', `/v1/admin/incidents/${p.incidentId}`),
  'admin.incident.ack': (e, p) => e.device.call('sos', 'POST', `/v1/admin/incidents/${p.incidentId}/acknowledge`),
  'admin.incident.escalate': (e, p) => e.device.call('sos', 'POST', `/v1/admin/incidents/${p.incidentId}/escalate`),
  'admin.incident.close': (e, p) => e.device.call('sos', 'POST', `/v1/admin/incidents/${p.incidentId}/close`, { resolution: p.resolution, legalHoldDays: Number(p.legalHoldDays) }),
  'admin.manifest': (e, p) => e.device.call('sos', 'GET', `/v1/admin/trips/${p.tripId}/manifest?reason=${encodeURIComponent(p.reason)}`),
  'admin.disclosure.request': (e, p) => e.device.call('sos', 'POST', '/v1/admin/authority-disclosures', { tripId: p.tripId, authority: p.authority, legalBasis: p.legalBasis }),
  'admin.disclosure.approve': (e, p) => e.device.call('sos', 'POST', `/v1/admin/authority-disclosures/${p.disclosureId}/approve`),

  // ----- Módulo 9: Taxi Ruta -----
  'routes.list': async (e) => {
    const r = await e.device.call('api', 'GET', '/v1/routes');
    if (r.status === 200 && r.body[0]) e.data.routeId ??= r.body[0].id;
    return r;
  },
  'route.detail': async (e, p) => {
    const r = await e.device.call('api', 'GET', `/v1/routes/${p.routeId || e.data.routeId}`);
    if (r.status === 200) {
      e.data.routeId = r.body.id;
      // Resumen legible: número de parada → nombre (las acciones usan ese número).
      return ok({ ...r.body, paradas: Object.fromEntries(r.body.directions.map((d: any) => [d.direction, d.stops.map((x: any) => `${x.seq}: ${x.name}${x.locationVerified ? '' : ' (sin verificar)'}`)])), directions: undefined });
    }
    return r;
  },
  'route.vehicles': async (e, p) => {
    const stop = await stopAt(e, p.direction, Number(p.from));
    return e.device.call('api', 'GET', `/v1/routes/${e.data.routeId}/vehicles?direction=${p.direction}${stop ? `&stopId=${stop}` : ''}`);
  },
  'route.quote': async (e, p) =>
    e.device.call('api', 'POST', `/v1/routes/${e.data.routeId}/quotes`, { direction: p.direction, boardingStopId: await stopAt(e, p.direction, Number(p.from)), alightingStopId: await stopAt(e, p.direction, Number(p.to)), seats: Number(p.seats) }),
  'route.book': async (e, p) => {
    const [from, to] = [await stopAt(e, p.direction, Number(p.from)), await stopAt(e, p.direction, Number(p.to))];
    let instanceId = p.instanceId;
    if (!instanceId) {
      const v = await e.device.call('api', 'GET', `/v1/routes/${e.data.routeId}/vehicles?direction=${p.direction}&stopId=${from}`);
      instanceId = v.body?.find((x: any) => x.seatsAvailable >= Number(p.seats))?.instanceId;
      if (!instanceId) return { status: 404, body: { title: 'No hay vehículos con asientos libres que aún no pasen por tu parada' } };
    }
    // Cada asiento adicional es un acompañante registrado (sección 5.1).
    const companions = Array.from({ length: Number(p.seats) - 1 }, (_, i) => ({
      givenNames: ['Luis', 'Rosa', 'Pedro', 'Elena'][i % 4], familyNames: 'Zambrano Ruiz', idType: 'cedula', idNumber: validCedula(), email: `acomp${i}.${Math.random().toString(36).slice(2, 6)}@correo.test`, isMinor: false,
    }));
    const r = await e.device.call('api', 'POST', `/v1/routes/${e.data.routeId}/bookings`, { instanceId, direction: p.direction, boardingStopId: from, alightingStopId: to, seats: Number(p.seats), paymentMethod: p.paymentMethod, companions });
    if (r.status === 201) Object.assign(e.data, { bookingId: r.body.bookingId, tripId: r.body.tripId });
    return r;
  },
  'route.booking': (e) => e.device.call('api', 'GET', `/v1/routes/bookings/${e.data.bookingId}`),
  'route.cancel': (e) => e.device.call('api', 'POST', `/v1/routes/bookings/${e.data.bookingId}/cancel`),
  'route.receipt': (e) => e.device.call('api', 'GET', `/v1/trips/${e.data.tripId}/receipt`),
  'droute.list': async (e) => {
    const r = await e.device.call('api', 'GET', '/v1/driver/routes');
    if (r.status === 200 && r.body[0]) e.data.routeId ??= r.body[0].id;
    return r;
  },
  'droute.catalog': async (e) => {
    const r = await e.device.call('api', 'GET', '/v1/driver/routes/catalog');
    if (r.status === 200 && r.body[0]) e.data.routeId ??= r.body[0].id;
    return r;
  },
  'droute.requestEnable': async (e, p) => {
    const vehicleId = e.data.vehicleId ?? (await e.device.call('api', 'GET', '/v1/driver/profile')).body?.vehicles?.[0]?.id;
    return e.device.call('api', 'POST', `/v1/driver/routes/${p.routeId || e.data.routeId}/enablement-requests`, { vehicleId });
  },
  'droute.start': async (e, p) => {
    const vehicleId = e.data.vehicleId ?? (await e.device.call('api', 'GET', '/v1/driver/profile')).body?.vehicles?.[0]?.id;
    const r = await e.device.call('api', 'POST', `/v1/driver/routes/${p.routeId || e.data.routeId}/instances`, { direction: p.direction, vehicleId });
    if (r.status === 201) Object.assign(e.data, { instanceId: r.body.instanceId, routeId: p.routeId || e.data.routeId, routeDirection: p.direction });
    return r;
  },
  'droute.current': (e) => e.device.call('api', 'GET', '/v1/driver/route-instances/current'),
  'droute.board': async (e, p) => {
    const bookingId = p.bookingId || (await e.device.call('api', 'GET', '/v1/driver/route-instances/current')).body?.bookings?.find((b: any) => b.status === 'reserved')?.id;
    return e.device.call('api', 'POST', `/v1/driver/route-instances/${e.data.instanceId}/board`, { bookingId, pin: p.pin });
  },
  'droute.alight': async (e, p) => {
    const bookingId = p.bookingId || (await e.device.call('api', 'GET', '/v1/driver/route-instances/current')).body?.bookings?.find((b: any) => b.status === 'boarded')?.id;
    return e.device.call('api', 'POST', `/v1/driver/route-instances/${e.data.instanceId}/alight`, { bookingId });
  },
  'droute.finish': (e) => e.device.call('api', 'POST', `/v1/driver/route-instances/${e.data.instanceId}/finish`),
  /** Avanza por el recorrido hasta la parada indicada, en pasos de ~80 m cada 2 s. */
  'droute.drive': async (e, p) => {
    const d = await e.device.call('api', 'GET', `/v1/routes/${e.data.routeId}`);
    const stops = d.body?.directions?.find((x: any) => x.direction === (e.data.routeDirection ?? 'outbound'))?.stops ?? [];
    const target = stops.find((x: any) => x.seq === Number(p.to));
    if (!target) return { status: 404, body: { title: 'Parada no encontrada (¿iniciaste el recorrido?)' } };
    const pts = [e.data.location ?? stops[0], ...stops.filter((x: any) => x.seq > (e.data.routeSeq ?? 0) && x.seq <= target.seq)];
    const path: { lat: number; lng: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot((pts[i].lat - pts[i - 1].lat) * 111_000, (pts[i].lng - pts[i - 1].lng) * 111_000) / 80));
      for (let k = 1; k <= n; k++) path.push({ lat: pts[i - 1].lat + ((pts[i].lat - pts[i - 1].lat) * k) / n, lng: pts[i - 1].lng + ((pts[i].lng - pts[i - 1].lng) * k) / n });
    }
    clearInterval(e.data.driveTimer);
    let i = 0;
    e.data.driveTimer = setInterval(async () => {
      const loc = path[i++];
      if (!loc) return clearInterval(e.data.driveTimer);
      e.data.location = loc;
      await e.device.call('api', 'POST', '/v1/driver/location', { location: loc }).catch(() => {});
    }, 2000);
    e.data.routeSeq = target.seq;
    return ok({ info: `Avanzando hasta "${target.name}" en ${path.length} pasos (~${path.length * 2} s)` });
  },
  'admin.routes': (e) => e.device.call('api', 'GET', '/v1/admin/routes'),
  'admin.route': (e, p) => e.device.call('api', 'GET', `/v1/admin/routes/${p.routeId}`),
  // Horario real de Taxi Ruta: diurna 06:30–20:59, nocturna 21:00 hasta el cierre (23:00); luego la ruta se cierra.
  'admin.route.fares': async (e, p) => {
    const close = String(p.close || '23:00');
    const rules = [
      { name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: Number(p.day) },
      { name: 'Nocturna', startLocal: '21:00', endLocal: close === '06:30' ? '06:30' : close, amountCents: Number(p.night) },
    ];
    const hours = close === '06:30' ? null : { start: '06:30', end: close };
    // Si se amplía el horario, primero las tarifas; si se reduce, primero el horario (cada paso valida la cobertura).
    const fares = await e.device.call('api', 'PUT', `/v1/admin/routes/${p.routeId}/fares`, { rules });
    if (fares.status >= 400) {
      await e.device.call('api', 'PUT', `/v1/admin/routes/${p.routeId}/service-hours`, { hours });
      return e.device.call('api', 'PUT', `/v1/admin/routes/${p.routeId}/fares`, { rules });
    }
    await e.device.call('api', 'PUT', `/v1/admin/routes/${p.routeId}/service-hours`, { hours });
    return fares;
  },
  'admin.route.validate': (e, p) => e.device.call('api', 'POST', `/v1/admin/routes/${p.routeId}/validate`),
  'admin.route.publishRequest': (e, p) => e.device.call('api', 'POST', `/v1/admin/routes/${p.routeId}/publish-request`),
  'admin.route.decide': (e, p) => e.device.call('api', 'POST', `/v1/admin/routes/${p.routeId}/publish-decision`, { approve: p.approve === 'true' }),
  'admin.route.pause': (e, p) => e.device.call('api', 'POST', `/v1/admin/routes/${p.routeId}/pause`, { reason: p.reason }),
  'admin.route.enable': (e, p) => e.device.call('api', 'POST', `/v1/admin/routes/${p.routeId}/drivers`, { driverId: p.driverId }),
  'admin.route.requests': (e, p) => e.device.call('api', 'GET', `/v1/admin/routes/enablement-requests?status=${p.status || 'pending'}`),
  'admin.route.requestDecide': async (e, p) => {
    const requestId = p.requestId || (await e.device.call('api', 'GET', '/v1/admin/routes/enablement-requests?status=pending')).body?.[0]?.id;
    if (!requestId) return { status: 404, body: { title: 'No hay solicitudes pendientes' } };
    return e.device.call('api', 'POST', `/v1/admin/routes/enablement-requests/${requestId}/decision`, { approve: p.approve === 'true', reason: p.reason || undefined });
  },

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
    for (const doc of d.body.documents) {
      const v = d.body.vehicles.find((x: any) => x.id === doc.vehicleId);
      const body = { decision: 'approved', ...(doc.type === 'registration' ? { confirmedSeats: v?.seats_passenger } : {}) };
      results.push((await e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/documents/${doc.id}/review`, body)).status);
    }
    return { status: 200, body: { revisados: results.length, estados: results } };
  },
  'admin.driver.decide': (e, p) => e.device.call('api', 'POST', `/v1/admin/drivers/${p.driverId}/decision`, { decision: p.decision, reason: p.reason }),
  'admin.role.grant': (e, p) => e.device.call('api', 'POST', `/v1/admin/users/${p.userId}/roles`, { role: p.role }),

  // ----- Genérica: cualquier endpoint de cualquier servicio, firmada con DPoP -----
  call: (e, p) => e.device.call(p.service ?? 'api', p.method ?? 'GET', p.path, p.body),
};

/** Id de la parada número `seq` del sentido indicado de la ruta seleccionada. */
async function stopAt(e: SimEntry, direction: string, seq: number): Promise<string | undefined> {
  const d = await e.device.call('api', 'GET', `/v1/routes/${e.data.routeId}`);
  return d.body?.directions?.find((x: any) => x.direction === direction)?.stops?.find((x: any) => x.seq === seq)?.id;
}

async function fetchJson(url: string, method: string, body?: unknown): Promise<HttpResult> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
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
