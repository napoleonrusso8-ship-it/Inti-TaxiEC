import { errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { verifyDpopProof, type DpopReplayStore } from './dpop.js';
import { AuthError } from './errors.js';

export interface SessionRevocationChecker {
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string;
  /** "urn:intitaxi:acr:otp" | "urn:intitaxi:acr:mfa" */
  acr: string;
  amr: string[];
  authTime: number;
  roles: string[];
  jkt: string;
}

export const ACR_BASIC = 'urn:intitaxi:acr:basic';
export const ACR_MFA = 'urn:intitaxi:acr:mfa';

export interface AccessTokenVerifierOptions {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
  replayStore: DpopReplayStore;
  revocation: SessionRevocationChecker;
}

export interface VerifyRequestInput {
  authorization: string | undefined;
  dpop: string | undefined;
  method: string;
  url: string;
}

/**
 * Verifica un token de acceso ligado a DPoP (RFC 9449 + perfil JWT RFC 9068).
 * Lo usan todos los servicios (auth, api, realtime, sos) para validar peticiones.
 */
export class AccessTokenVerifier {
  constructor(private readonly opts: AccessTokenVerifierOptions) {}

  async verify(input: VerifyRequestInput): Promise<AuthContext> {
    const m = /^DPoP ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(input.authorization ?? '');
    if (!m) throw new AuthError('invalid_token', 'Se requiere el esquema de autorización DPoP');
    const token = m[1]!;

    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.opts.keys, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        typ: 'at+jwt',
        algorithms: ['ES256'],
        requiredClaims: ['sub', 'exp', 'iat', 'sid', 'cnf'],
        clockTolerance: 5,
      }));
    } catch (e) {
      const reason = e instanceof joseErrors.JOSEError ? e.code : 'unknown';
      throw new AuthError('invalid_token', `Token de acceso inválido (${reason})`);
    }

    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    if (typeof cnf?.jkt !== 'string') throw new AuthError('invalid_token', 'El token no está ligado a DPoP');

    const { jkt } = await verifyDpopProof({
      proof: input.dpop,
      method: input.method,
      url: input.url,
      accessToken: token,
      replayStore: this.opts.replayStore,
    });
    if (jkt !== cnf.jkt) throw new AuthError('invalid_token', 'La clave DPoP no corresponde al token');

    const sid = String(payload.sid);
    if (await this.opts.revocation.isSessionRevoked(sid)) throw new AuthError('invalid_token', 'Sesión revocada');

    return {
      userId: payload.sub!,
      sessionId: sid,
      deviceId: String(payload.did ?? ''),
      acr: String(payload.acr ?? ACR_BASIC),
      amr: Array.isArray(payload.amr) ? payload.amr.map(String) : [],
      authTime: Number(payload.auth_time ?? payload.iat),
      roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
      jkt,
    };
  }
}

/** Comprueba que la autenticación fuerte (MFA) sea reciente para operaciones sensibles. */
export function assertRecentMfa(ctx: AuthContext, maxAgeSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (ctx.acr !== ACR_MFA || nowSeconds - ctx.authTime > maxAgeSeconds) {
    throw new AuthError('insufficient_user_authentication', 'Se requiere verificación reciente (step-up)');
  }
}
