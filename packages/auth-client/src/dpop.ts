import { randomBase64url, sha256Base64url } from './encoding.js';

/**
 * Firmante DPoP. En la app móvil la clave privada se genera y permanece en
 * Secure Enclave (iOS) / StrongBox-TEE (Android) y nunca es exportable;
 * aquí solo se define la interfaz que implementa el módulo nativo.
 */
/** Clave pública EC P-256 en formato JWK. */
export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface DpopSigner {
  readonly publicJwk: PublicJwk;
  /** Firma un JWS compacto ES256 con la cabecera y el payload dados. */
  signJws(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string>;
}

export async function createDpopProof(
  signer: DpopSigner,
  input: { method: string; url: string; accessToken?: string; nowSeconds?: number },
): Promise<string> {
  const u = new URL(input.url);
  const payload: Record<string, unknown> = {
    htm: input.method.toUpperCase(),
    htu: `${u.protocol}//${u.host}${u.pathname}`,
    iat: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    jti: randomBase64url(24),
  };
  if (input.accessToken) payload.ath = await sha256Base64url(input.accessToken);
  return signer.signJws({ alg: 'ES256', typ: 'dpop+jwt', jwk: signer.publicJwk }, payload);
}
