import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, EmbeddedJWK, errors as joseErrors, jwtVerify, type JWK } from 'jose';
import { AuthError } from './errors.js';

/** Registro de `jti` ya usados para impedir la repetición de pruebas DPoP. */
export interface DpopReplayStore {
  /** Devuelve true si el jti no se había visto; lo marca como usado durante `ttlSeconds`. */
  markUsed(jti: string, ttlSeconds: number): Promise<boolean>;
}

export interface DpopVerifyInput {
  proof: string | undefined;
  method: string;
  /** URL pública canónica del recurso (se ignoran query y fragmento). Nunca derivarla de la cabecera Host. */
  url: string;
  /** Si se presenta un token de acceso, la prueba debe incluir `ath` = SHA-256 del token. */
  accessToken?: string;
  replayStore: DpopReplayStore;
  maxAgeSeconds?: number;
  clockToleranceSeconds?: number;
}

export interface DpopResult {
  jkt: string;
  jwk: JWK;
}

const ALGS = ['ES256', 'EdDSA'];

export function canonicalHtu(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/** Verifica una prueba DPoP según RFC 9449. */
export async function verifyDpopProof(input: DpopVerifyInput): Promise<DpopResult> {
  if (!input.proof || input.proof.length > 4096) throw new AuthError('invalid_dpop_proof', 'Falta la prueba DPoP');
  const maxAge = input.maxAgeSeconds ?? 60;
  let verified;
  try {
    verified = await jwtVerify(input.proof, EmbeddedJWK, {
      typ: 'dpop+jwt',
      algorithms: ALGS,
      maxTokenAge: `${maxAge}s`,
      clockTolerance: input.clockToleranceSeconds ?? 5,
    });
  } catch (e) {
    const reason = e instanceof joseErrors.JOSEError ? e.code : 'unknown';
    throw new AuthError('invalid_dpop_proof', `Prueba DPoP inválida (${reason})`);
  }
  const { payload, protectedHeader } = verified;
  const jwk = protectedHeader.jwk as JWK | undefined;
  if (!jwk || 'd' in jwk) throw new AuthError('invalid_dpop_proof', 'La prueba DPoP contiene una clave privada');
  if (payload.htm !== input.method.toUpperCase()) throw new AuthError('invalid_dpop_proof', 'htm no coincide');
  if (typeof payload.htu !== 'string' || canonicalHtu(payload.htu) !== canonicalHtu(input.url)) {
    throw new AuthError('invalid_dpop_proof', 'htu no coincide');
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 128) {
    throw new AuthError('invalid_dpop_proof', 'jti inválido');
  }
  if (input.accessToken !== undefined) {
    const ath = createHash('sha256').update(input.accessToken).digest('base64url');
    if (payload.ath !== ath) throw new AuthError('invalid_dpop_proof', 'ath no coincide con el token');
  }
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  // Se marca al final para no consumir jti de pruebas que de todas formas son inválidas.
  const fresh = await input.replayStore.markUsed(`${jkt}:${payload.jti}`, maxAge * 2);
  if (!fresh) throw new AuthError('invalid_dpop_proof', 'Prueba DPoP repetida');
  return { jkt, jwk };
}
