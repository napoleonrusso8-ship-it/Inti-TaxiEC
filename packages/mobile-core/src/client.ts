import { codeChallengeS256, createCodeVerifier, createDpopProof, TokenManager, type DpopSigner, type SecureStore } from '@intitaxi/auth-client';

export type ServiceName = 'auth' | 'api' | 'sos' | 'realtime';

export interface ClientConfig {
  services: Record<ServiceName, string>;
  /** ec.intitaxi.passenger / ec.intitaxi.driver */
  appId: string;
  clientId: 'intitaxi-passenger' | 'intitaxi-driver';
}

/** Obtiene el token de atestación para un nonce del servidor (Play Integrity en producción). */
export type Attestor = (nonce: string) => Promise<string>;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

/** Error de la API con el problem+json del servidor (`title` es el código estable, `detail` el mensaje). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { title?: string; detail?: string; [k: string]: unknown } | null,
  ) {
    super(body?.detail ?? body?.title ?? `Error ${status}`);
  }
  get code() {
    return this.body?.title ?? `http_${this.status}`;
  }
}

/** Ticket de atestación: se renueva antes de que caduque (10 min) o cuando el servidor lo pide. */
const TICKET_MARGIN_MS = 60_000;

/**
 * Cliente HTTP de la app:
 * - toda petición lleva una prueba DPoP firmada con la clave del Keystore;
 * - las rutas que lo exigen llevan el ticket de atestación (Play Integrity);
 * - el token de acceso (10 min) vive solo en memoria y se renueva con el refresh token rotativo
 *   guardado en almacenamiento seguro.
 */
export class ApiClient {
  readonly tokens: TokenManager;
  #ticket: { value: string; expiresAt: number; deviceId: string } | null = null;
  #attesting: Promise<void> | null = null;
  #loggedIn = false;
  sessionEnded: (reason: string) => void = () => {};

  constructor(
    readonly config: ClientConfig,
    readonly signer: DpopSigner,
    private readonly store: SecureStore,
    private readonly attestor: Attestor,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {
    this.tokens = new TokenManager(
      { tokenEndpoint: `${config.services.auth}/oauth/token`, clientId: config.clientId },
      signer,
      store,
      async (url, init) => {
        const r = await this.fetchFn(url, init);
        const text = await r.text();
        return { status: r.status, json: async () => (text ? JSON.parse(text) : {}) };
      },
      (reason) => {
        this.#loggedIn = false;
        this.sessionEnded(reason);
      },
    );
  }

  get deviceId() {
    return this.#ticket?.deviceId ?? null;
  }

  get loggedIn() {
    return this.#loggedIn;
  }

  /** ¿Hay una sesión guardada? Intenta renovarla (al abrir la app). */
  async restore(): Promise<boolean> {
    if (!(await this.store.get('intitaxi.refresh_token'))) return false;
    try {
      await this.tokens.getAccessToken();
      this.#loggedIn = true;
      return true;
    } catch {
      return false;
    }
  }

  async attest(force = false): Promise<void> {
    if (!force && this.#ticket && Date.now() < this.#ticket.expiresAt - TICKET_MARGIN_MS) return;
    this.#attesting ??= (async () => {
      this.#ticket = null;
      const n = await this.#send('auth', 'POST', '/v1/attestation/nonce', undefined, { auth: false, attest: false });
      const token = await this.attestor(n.nonce);
      const r = await this.#send('auth', 'POST', '/v1/attestation/verify', { platform: 'android', appId: this.config.appId, nonce: n.nonce, token }, { auth: false, attest: false });
      this.#ticket = { value: r.ticket, deviceId: r.deviceId, expiresAt: Date.now() + r.expiresIn * 1000 };
    })().finally(() => {
      this.#attesting = null;
    });
    return this.#attesting;
  }

  /** Petición autenticada. Reintenta una vez si el servidor pide una atestación nueva. */
  async call<T = any>(service: ServiceName, method: string, path: string, body?: unknown, opts: { auth?: boolean; idempotencyKey?: string; form?: boolean } = {}): Promise<T> {
    try {
      return await this.#send(service, method, path, body, opts);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'attestation_required') {
        await this.attest(true);
        return this.#send(service, method, path, body, opts);
      }
      throw e;
    }
  }

  async #send(service: ServiceName, method: string, path: string, body: unknown, opts: { auth?: boolean; attest?: boolean; idempotencyKey?: string; form?: boolean }): Promise<any> {
    if (opts.attest !== false) await this.attest();
    const url = `${this.config.services[service]}${path}`;
    const headers: Record<string, string> =
      opts.auth === false ? { DPoP: await createDpopProof(this.signer, { method, url }) } : await this.tokens.authHeaders(method, url);
    if (this.#ticket) headers['X-Attestation-Ticket'] = this.#ticket.value;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = opts.form ? 'application/x-www-form-urlencoded' : 'application/json';
      payload = opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
    }
    const res = await this.fetchFn(url, { method, headers, body: payload });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { detail: text.slice(0, 200) };
    }
    if (res.status >= 400) {
      if (res.status === 401 && parsed?.title !== 'attestation_required' && opts.auth !== false) {
        this.#loggedIn = false;
        this.sessionEnded('unauthorized');
      }
      throw new ApiError(res.status, parsed);
    }
    return parsed;
  }

  // ---------- Inicio de sesión ----------

  requestOtp(phone: string): Promise<{ challengeId: string; expiresIn: number }> {
    return this.call('auth', 'POST', '/v1/auth/otp/request', { phone }, { auth: false });
  }

  async verifyOtp(challengeId: string, code: string): Promise<void> {
    const verifier = createCodeVerifier();
    const v = await this.call<{ code: string }>('auth', 'POST', '/v1/auth/otp/verify', { challengeId, code, codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' }, { auth: false });
    await this.tokens.exchangeCode(v.code, verifier);
    this.#loggedIn = true;
  }

  /** Inicio de sesión con passkey: `getAssertion` llama a Credential Manager con las opciones del servidor. */
  async loginWithPasskey(getAssertion: (options: unknown) => Promise<unknown>): Promise<void> {
    const o = await this.call<{ flowId: string; options: unknown }>('auth', 'POST', '/v1/auth/passkeys/authentication/options', {}, { auth: false });
    const verifier = createCodeVerifier();
    const v = await this.call<{ code: string }>('auth', 'POST', '/v1/auth/passkeys/authentication/verify', { flowId: o.flowId, response: await getAssertion(o.options), codeChallenge: await codeChallengeS256(verifier), codeChallengeMethod: 'S256' }, { auth: false });
    await this.tokens.exchangeCode(v.code, verifier);
    this.#loggedIn = true;
  }

  async registerPasskey(create: (options: unknown) => Promise<unknown>) {
    const opts = await this.call('auth', 'POST', '/v1/auth/passkeys/registration/options');
    return this.call('auth', 'POST', '/v1/auth/passkeys/registration/verify', await create(opts));
  }

  async logout(): Promise<void> {
    try {
      await this.call('auth', 'POST', '/v1/auth/logout');
    } catch {
      /* la sesión puede haber caducado */
    }
    await this.tokens.logout();
    this.#loggedIn = false;
  }

  /** Prueba DPoP para el WebSocket de tiempo real (autenticación por mensaje). */
  async socketAuth(type: 'auth' | 'reauth' = 'auth') {
    const url = `${this.config.services.realtime}/v1/ws`;
    const at = await this.tokens.getAccessToken();
    return { type, authorization: `DPoP ${at}`, dpop: await createDpopProof(this.signer, { method: 'GET', url, accessToken: at }) };
  }
}

/** Clave de idempotencia para solicitudes que no deben duplicarse si la red falla. */
export function idempotencyKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  return `m-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
