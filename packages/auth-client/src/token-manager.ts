import { createDpopProof, type DpopSigner } from './dpop.js';

/** Almacenamiento seguro (Keychain / Keystore). Nunca AsyncStorage ni archivos planos. */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'DPoP';
  expires_in: number;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const REFRESH_KEY = 'intitaxi.refresh_token';
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * Gestiona el ciclo de vida de los tokens en el cliente:
 * - el token de acceso solo vive en memoria;
 * - el refresh token vive en almacenamiento seguro y se sustituye en cada rotación;
 * - las renovaciones concurrentes se agrupan en una sola petición (si dos peticiones
 *   usaran el mismo refresh token, el servidor detectaría reutilización y cerraría la sesión).
 */
export class TokenManager {
  #accessToken: string | undefined;
  #expiresAt = 0;
  #refreshing: Promise<string> | undefined;

  constructor(
    /**
     * `refreshTokenKey`: clave en el almacenamiento seguro. En la app única hay un TokenManager por cliente
     * (pasajero y socio): cada uno debe usar su propia clave para no pisar el refresh token del otro.
     */
    private readonly cfg: { tokenEndpoint: string; clientId: string; skewSeconds?: number; refreshTokenKey?: string },
    private readonly signer: DpopSigner,
    private readonly store: SecureStore,
    private readonly fetchFn: Fetch,
    private readonly onSessionEnded: (reason: string) => void = () => {},
  ) {}

  async exchangeCode(code: string, codeVerifier: string): Promise<void> {
    await this.#tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, client_id: this.cfg.clientId });
  }

  /**
   * Token exchange (RFC 8693): con el token de acceso de OTRO cliente de la app única (p. ej. el de pasajero)
   * obtiene una sesión propia para `clientId` sin otro SMS. Debe usar la MISMA clave DPoP que ese token.
   */
  async exchangeToken(subjectAccessToken: string): Promise<void> {
    await this.#tokenRequest({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectAccessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      client_id: this.cfg.clientId,
    });
  }

  get #key() {
    return this.cfg.refreshTokenKey ?? REFRESH_KEY;
  }

  async getAccessToken(nowMs = Date.now()): Promise<string> {
    const skew = (this.cfg.skewSeconds ?? 30) * 1000;
    if (this.#accessToken && nowMs < this.#expiresAt - skew) return this.#accessToken;
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** Cabeceras para una petición autenticada al recurso indicado. */
  async authHeaders(method: string, url: string): Promise<Record<string, string>> {
    const at = await this.getAccessToken();
    return { Authorization: `DPoP ${at}`, DPoP: await createDpopProof(this.signer, { method, url, accessToken: at }) };
  }

  async logout(): Promise<void> {
    this.#accessToken = undefined;
    this.#expiresAt = 0;
    await this.store.delete(this.#key);
  }

  async #refresh(): Promise<string> {
    const rt = await this.store.get(this.#key);
    if (!rt) {
      this.onSessionEnded('no_refresh_token');
      throw new Error('Sesión no iniciada');
    }
    await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: rt, client_id: this.cfg.clientId });
    return this.#accessToken!;
  }

  async #tokenRequest(form: Record<string, string>) {
    const res = await this.fetchFn(this.cfg.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: await createDpopProof(this.signer, { method: 'POST', url: this.cfg.tokenEndpoint }),
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json()) as Partial<TokenResponse> & { error?: string };
    if (res.status !== 200 || !body.access_token || !body.refresh_token) {
      if (body.error === 'invalid_grant') {
        await this.logout();
        this.onSessionEnded('invalid_grant');
      }
      throw new Error(`Error al obtener tokens: ${body.error ?? res.status}`);
    }
    // Guardar primero el nuevo refresh token: si la app muere aquí, el siguiente arranque usa el bueno.
    await this.store.set(this.#key, body.refresh_token);
    this.#accessToken = body.access_token;
    this.#expiresAt = Date.now() + (body.expires_in ?? 0) * 1000;
  }
}
