import { createLocalJWKSet, exportJWK, importPKCS8, SignJWT, type CryptoKey, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config.js';

/**
 * Claves de firma de tokens (ES256).
 * La clave privada llega desde Secrets Manager (inyectada como variable de entorno en el contenedor)
 * y se rota publicando la anterior en JWT_PREVIOUS_PUBLIC_JWKS durante al menos un TTL de token.
 * Mejora prevista: firmar directamente con una clave asimétrica de KMS para que la privada nunca esté en memoria.
 */
export class SigningKeys {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly kid: string,
    readonly jwks: JSONWebKeySet,
    readonly getKey: JWTVerifyGetKey,
  ) {}

  static async fromConfig(c: AppConfig): Promise<SigningKeys> {
    const privateKey = await importPKCS8(c.JWT_SIGNING_KEY_PEM.replace(/\\n/g, '\n'), 'ES256', { extractable: true });
    const { d: _d, ...pub } = await exportJWK(privateKey);
    const current = { ...pub, kid: c.JWT_SIGNING_KID, alg: 'ES256', use: 'sig' };
    const previous = (JSON.parse(c.JWT_PREVIOUS_PUBLIC_JWKS) as JSONWebKeySet).keys.filter((k) => !('d' in k));
    const jwks = { keys: [current, ...previous] };
    return new SigningKeys(privateKey, c.JWT_SIGNING_KID, jwks, createLocalJWKSet(jwks));
  }

  sign(payload: JWTPayload, typ: string, expiresInSeconds: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', typ, kid: this.kid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.privateKey);
  }
}
