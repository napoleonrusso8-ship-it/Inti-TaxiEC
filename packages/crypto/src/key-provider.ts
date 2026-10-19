import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Proveedor de claves para envelope encryption.
 * La clave maestra (CMK) nunca sale del proveedor: solo se obtienen claves de datos (DEK)
 * de un solo uso lógico, envueltas por la CMK y ligadas a un contexto de cifrado.
 */
export interface KeyProvider {
  /** Identificador estable del proveedor/CMK (se registra, nunca es secreto). */
  readonly keyId: string;
  generateDataKey(context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer>;
}

export type EncryptionContext = Readonly<Record<string, string>>;

export function serializeContext(context: EncryptionContext): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

/**
 * Proveedor local SOLO para desarrollo y pruebas. Envuelve las DEK con AES-256-GCM
 * usando una clave maestra de 32 bytes recibida por variable de entorno.
 * La configuración de cada servicio rechaza este proveedor en producción.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKeyBase64: string, keyId = 'local-dev') {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('LocalKeyProvider: la clave maestra debe tener 32 bytes');
    this.#masterKey = key;
    this.keyId = keyId;
  }

  async generateDataKey(context: EncryptionContext) {
    const plaintext = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, iv);
    cipher.setAAD(serializeContext(context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]) };
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext) {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, iv);
    decipher.setAAD(serializeContext(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}
