import { base64url, type DpopSigner, type PublicJwk } from '@intitaxi/auth-client';

/** Operaciones mínimas de una clave en hardware (Android Keystore). */
export interface HardwareKey {
  ensureKey(alias: string): Promise<PublicJwk & { hardware?: string }>;
  sign(alias: string, dataB64u: string): Promise<string>;
}

const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));

/**
 * Firmante DPoP cuya clave privada vive en el Keystore: aquí solo se arma el JWS y se pide la firma.
 * La clave es por instalación: si la app se reinstala, se genera otra y el servidor ve un dispositivo nuevo.
 */
export async function hardwareSigner(hw: HardwareKey, alias = 'intitaxi.dpop'): Promise<DpopSigner & { hardware: string }> {
  const jwk = await hw.ensureKey(alias);
  return {
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    hardware: jwk.hardware ?? 'unknown',
    async signJws(header, payload) {
      const input = `${enc(header)}.${enc(payload)}`;
      return `${input}.${await hw.sign(alias, base64url(new TextEncoder().encode(input)))}`;
    },
  };
}
