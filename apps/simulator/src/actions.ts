import type { HttpResult, SimDevice } from '@intitaxi/testkit';

export interface SimEntry {
  id: string;
  label: string;
  role: string;
  integrity: string;
  phone?: string;
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

/** Acciones disponibles en el simulador. Cada módulo añade las suyas. */
export const actions: Record<string, Handler> = {
  // ----- Módulo 1: autenticación -----
  'otp.request': async (e, p) => {
    e.phone = p.phone;
    const r = await e.device.requestOtp(p.phone);
    if (r.status === 202) e.data.challengeId = r.body.challengeId;
    return r;
  },
  'otp.verify': (e, p) => e.device.verifyOtp(p.challengeId ?? e.data.challengeId, p.code),
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
    return e.device.loginWithPasskey(authenticator);
  },
  'stepup.passkey': (e) => e.device.stepUpPasskey(),
  'devicekey.register': (e) => e.device.registerDeviceKey(),
  'devicekey.login': (e) => e.device.loginWithDeviceKey(),
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

  // ----- Genérica: cualquier endpoint de cualquier servicio, firmada con DPoP -----
  call: (e, p) => e.device.call(p.service ?? 'api', p.method ?? 'GET', p.path, p.body),
};

export async function runAction(e: SimEntry, action: string, params: Record<string, any>, ctx: ActionContext): Promise<HttpResult> {
  const h = actions[action];
  if (!h) return { status: 400, body: { error: `acción desconocida: ${action}` } };
  try {
    return await h(e, params, ctx);
  } catch (err) {
    return { status: 599, body: { error: `fallo de red o del simulador: ${(err as Error).message}` } };
  }
}
