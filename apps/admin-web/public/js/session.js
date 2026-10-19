// Sesión del panel: clave DPoP no extraíble en WebCrypto, PKCE, passkey y tokens SOLO en memoria.
// Recargar la página cierra la sesión (no hay tokens en localStorage/cookies que un XSS o malware pueda robar).
import { base64url, codeChallengeS256, createCodeVerifier, createDpopProof, TokenManager } from '/lib/auth-client/index.js';
import { credentialToJSON, toPublicKeyRequest } from './webauthn.js';

const CLIENT_ID = 'intitaxi-admin';

/** Firmante ES256 con clave privada no exportable (ni siquiera el propio código puede leerla). */
async function webCryptoSigner() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', publicKey);
  const enc = (o) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  return {
    publicJwk: { kty, crv, x, y },
    async signJws(header, payload) {
      const input = `${enc(header)}.${enc(payload)}`;
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input));
      return `${input}.${base64url(new Uint8Array(sig))}`;
    },
  };
}

class MemoryStore {
  #m = new Map();
  async get(k) { return this.#m.get(k) ?? null; }
  async set(k, v) { this.#m.set(k, v); }
  async delete(k) { this.#m.delete(k); }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail ?? body?.title ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export class Session {
  constructor(config, onEnded) {
    this.config = config;
    this.onEnded = onEnded;
    this.roles = [];
    this.userId = null;
  }

  async #signer() {
    this.signer ??= await webCryptoSigner();
    return this.signer;
  }

  async #raw(url, init) {
    const r = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  /** Inicio de sesión: reto WebAuthn ligado a la clave DPoP → código → tokens (PKCE). */
  async login(mode, devDeviceId) {
    const signer = await this.#signer();
    const auth = this.config.services.auth;
    const post = async (path, body) => {
      const url = `${auth}${path}`;
      return this.#raw(url, { method: 'POST', headers: { 'Content-Type': 'application/json', DPoP: await createDpopProof(signer, { method: 'POST', url }) }, body: JSON.stringify(body) });
    };
    const o = await post('/v1/auth/admin/passkey/options', {});
    if (o.status !== 200) throw new ApiError(o.status, o.body);
    let response;
    if (mode === 'dev') {
      const r = await this.#raw('/dev/authenticator/assert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: devDeviceId, options: o.body.options, origin: location.origin }) });
      if (r.status !== 200) throw new ApiError(r.status, r.body);
      response = r.body;
    } else {
      const cred = await navigator.credentials.get({ publicKey: toPublicKeyRequest(o.body.options), mediation: 'required' });
      response = credentialToJSON(cred);
    }
    const verifier = createCodeVerifier();
    const v = await post('/v1/auth/admin/passkey/verify', { flowId: o.body.flowId, response, codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' });
    if (v.status !== 200) throw new ApiError(v.status, v.body);
    this.tokens = new TokenManager(
      { tokenEndpoint: `${auth}/oauth/token`, clientId: CLIENT_ID },
      signer,
      new MemoryStore(),
      (url, init) => fetch(url, { ...init, credentials: 'omit' }),
      (reason) => this.onEnded(reason),
    );
    await this.tokens.exchangeCode(v.body.code, verifier);
    const me = await this.call('api', 'GET', '/v1/admin/me');
    this.userId = me.userId;
    this.roles = me.roles;
  }

  has(...roles) {
    return this.roles.includes('super_admin') || roles.some((r) => this.roles.includes(r));
  }

  /** Petición autenticada (DPoP con ath). Lanza ApiError con el problem+json del servidor. */
  async call(service, method, path, body) {
    const url = `${this.config.services[service]}${path}`;
    const headers = { ...(await this.tokens.authHeaders(method, url)), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const r = await this.#raw(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 401) this.onEnded('unauthorized');
    if (r.status >= 400) throw new ApiError(r.status, r.body);
    return r.body;
  }

  async logout() {
    try {
      await this.call('auth', 'POST', '/v1/auth/logout');
    } catch {
      /* la sesión puede haber expirado ya */
    }
    await this.tokens?.logout();
    this.tokens = undefined;
    this.signer = undefined;
  }
}
