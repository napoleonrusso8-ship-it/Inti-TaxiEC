import { codeChallengeS256, createCodeVerifier, createDpopProof, type DpopSigner } from '@intitaxi/auth-client';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { SoftwareAuthenticator } from './webauthn-authenticator.js';

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export type Integrity = 'ok' | 'basic' | 'fail';

/**
 * Instalación simulada de la app que habla con los servicios reales por HTTP:
 * clave DPoP propia, atestación de desarrollo, PKCE, passkey y clave biométrica por software.
 * Solo funciona contra servicios con ATTESTATION_MODE=dev.
 */
export class SimDevice {
  signer!: DpopSigner;
  ticket = '';
  deviceId = '';
  accessToken = '';
  refreshToken = '';
  bioKey: { privateKey: CryptoKey; publicJwk: JWK; credentialId?: string } | undefined;
  passkey: SoftwareAuthenticator | undefined;

  private constructor(
    readonly services: Record<string, string>,
    readonly appId: string,
    readonly clientId: string,
  ) {}

  static async create(opts: { services: Record<string, string>; appId: string; clientId: string; integrity?: Integrity }) {
    const d = new SimDevice(opts.services, opts.appId, opts.clientId);
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    d.signer = {
      publicJwk: (await exportJWK(publicKey)) as DpopSigner['publicJwk'],
      signJws: (header, payload) => new SignJWT(payload).setProtectedHeader(header as never).sign(privateKey),
    };
    const att = await d.attest(opts.integrity ?? 'ok');
    if (att.status !== 200) throw Object.assign(new Error(`atestación rechazada (${att.status})`), { result: att });
    return d;
  }

  #url(service: string, path: string) {
    const base = this.services[service];
    if (!base) throw new Error(`servicio desconocido: ${service}`);
    return base + path;
  }

  /** Petición HTTP con DPoP (+ token y ticket si existen). */
  async call<T = any>(service: string, method: string, path: string, body?: unknown, opts: { auth?: boolean; form?: boolean; accessToken?: string } = {}): Promise<HttpResult<T>> {
    const url = this.#url(service, path);
    const at = opts.accessToken ?? (opts.auth === false ? undefined : this.accessToken || undefined);
    const headers: Record<string, string> = { DPoP: await createDpopProof(this.signer, { method, url, accessToken: at }) };
    if (at) headers.Authorization = `DPoP ${at}`;
    if (this.ticket) headers['X-Attestation-Ticket'] = this.ticket;
    let payload: string | undefined;
    if (body !== undefined) {
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        payload = new URLSearchParams(body as Record<string, string>).toString();
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* texto plano */
    }
    return { status: res.status, body: parsed as T };
  }

  async attest(integrity: Integrity) {
    this.ticket = '';
    const n = await this.call('auth', 'POST', '/v1/attestation/nonce', undefined, { auth: false });
    if (n.status !== 200) return n;
    const token = integrity === 'ok' ? `dev-ok:${n.body.nonce}` : integrity === 'basic' ? `dev-basic:${n.body.nonce}` : 'dev-fail';
    const r = await this.call('auth', 'POST', '/v1/attestation/verify', { platform: 'android', appId: this.appId, nonce: n.body.nonce, token }, { auth: false });
    if (r.status === 200) {
      this.ticket = r.body.ticket;
      this.deviceId = r.body.deviceId;
    }
    return r;
  }

  requestOtp(phone: string) {
    return this.call('auth', 'POST', '/v1/auth/otp/request', { phone }, { auth: false });
  }

  async #exchange(code: string, verifier: string) {
    const t = await this.call('auth', 'POST', '/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: this.clientId }, { auth: false, form: true });
    if (t.status === 200) {
      this.accessToken = t.body.access_token;
      this.refreshToken = t.body.refresh_token;
    }
    return t;
  }

  async verifyOtp(challengeId: string, code: string) {
    const verifier = createCodeVerifier();
    const v = await this.call('auth', 'POST', '/v1/auth/otp/verify', { challengeId, code, codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' }, { auth: false });
    if (v.status !== 200) return v;
    const t = await this.#exchange(v.body.code, verifier);
    return t.status === 200 ? { status: 200, body: { isNewUser: v.body.isNewUser, expiresIn: t.body.expires_in } } : t;
  }

  async refresh() {
    const t = await this.call('auth', 'POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId }, { auth: false, form: true });
    if (t.status === 200) {
      this.accessToken = t.body.access_token;
      this.refreshToken = t.body.refresh_token;
    }
    return t;
  }

  async registerPasskey(rpId: string, origin: string) {
    const opts = await this.call('auth', 'POST', '/v1/auth/passkeys/registration/options');
    if (opts.status !== 200) return opts;
    const auth = this.passkey ?? new SoftwareAuthenticator(rpId, origin);
    const r = await this.call('auth', 'POST', '/v1/auth/passkeys/registration/verify', auth.register(opts.body));
    if (r.status === 201) this.passkey = auth;
    return r;
  }

  /** Inicia sesión con la passkey de otro dispositivo simulado (passkey sincronizada). */
  async loginWithPasskey(authenticator: SoftwareAuthenticator) {
    const o = await this.call('auth', 'POST', '/v1/auth/passkeys/authentication/options', {}, { auth: false });
    if (o.status !== 200) return o;
    const verifier = createCodeVerifier();
    const v = await this.call(
      'auth',
      'POST',
      '/v1/auth/passkeys/authentication/verify',
      { flowId: o.body.flowId, response: authenticator.assert(o.body.options), codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' },
      { auth: false },
    );
    if (v.status !== 200) return v;
    this.passkey = authenticator;
    return this.#exchange(v.body.code, verifier);
  }

  async stepUpPasskey() {
    if (!this.passkey) return { status: 409, body: { title: 'sin passkey en este dispositivo simulado' } };
    const o = await this.call('auth', 'POST', '/v1/auth/step-up/passkey/options');
    if (o.status !== 200) return o;
    const r = await this.call('auth', 'POST', '/v1/auth/step-up/passkey/verify', this.passkey.assert(o.body));
    if (r.status === 200) this.accessToken = r.body.access_token;
    return r;
  }

  async registerDeviceKey() {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const r = await this.call('auth', 'POST', '/v1/auth/device-keys', { publicJwk });
    if (r.status === 201) this.bioKey = { privateKey, publicJwk, credentialId: r.body.credentialId };
    return r;
  }

  #signBio(payload: object) {
    return new SignJWT(payload as never).setProtectedHeader({ alg: 'ES256' }).sign(this.bioKey!.privateKey);
  }

  async loginWithDeviceKey() {
    if (!this.bioKey?.credentialId) return { status: 409, body: { title: 'sin clave biométrica registrada' } };
    const c = await this.call('auth', 'POST', '/v1/auth/device-keys/challenge', {}, { auth: false });
    if (c.status !== 200) return c;
    const verifier = createCodeVerifier();
    const v = await this.call(
      'auth',
      'POST',
      '/v1/auth/device-keys/assert',
      {
        challengeId: c.body.challengeId,
        credentialId: this.bioKey.credentialId,
        assertion: await this.#signBio({ challenge: c.body.challenge }),
        codeChallenge: await codeChallengeS256(verifier),
        codeChallengeMethod: 'S256',
      },
      { auth: false },
    );
    return v.status === 200 ? this.#exchange(v.body.code, verifier) : v;
  }

  async stepUpEmailOptions() {
    return this.call('auth', 'POST', '/v1/auth/step-up/email/options');
  }

  async stepUpEmailVerify(code: string, challenge: string) {
    if (!this.bioKey) return { status: 409, body: { title: 'sin clave biométrica registrada' } };
    const r = await this.call('auth', 'POST', '/v1/auth/step-up/email/verify', { code, assertion: await this.#signBio({ challenge }) });
    if (r.status === 200) this.accessToken = r.body.access_token;
    return r;
  }

  /** Firma arbitraria con la clave biométrica (para módulos que la exijan). */
  signWithDeviceKey(payload: object) {
    return this.#signBio(payload);
  }
}
