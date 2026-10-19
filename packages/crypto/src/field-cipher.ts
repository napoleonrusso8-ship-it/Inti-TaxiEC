import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { EncryptionContext, KeyProvider } from './key-provider.js';

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

export interface FieldCipherOptions {
  /** Contexto de cifrado de la DEK (p. ej. { service: 'auth', purpose: 'pii' }). */
  context: EncryptionContext;
  /** Máximo de cifrados con la misma DEK antes de rotarla. */
  maxUsesPerKey?: number;
  /** Edad máxima de la DEK activa. */
  maxKeyAgeMs?: number;
  /** Máximo de DEK descifradas en caché. */
  cacheSize?: number;
}

interface ActiveKey {
  plaintext: Buffer;
  wrapped: Buffer;
  uses: number;
  createdAt: number;
}

/**
 * Cifrado a nivel de campo (AES-256-GCM) con envelope encryption.
 *
 * Formato: [versión 1B][long. DEK envuelta 2B][DEK envuelta][IV 12B][tag 16B][texto cifrado]
 *
 * El parámetro `aad` debe identificar unívocamente el campo (p. ej. "identity.users.phone:<id>")
 * para que un texto cifrado no pueda copiarse a otra fila o columna sin que falle la autenticación.
 */
export class FieldCipher {
  #active: ActiveKey | undefined;
  #pending: Promise<ActiveKey> | undefined;
  readonly #cache = new Map<string, Buffer>();
  readonly #maxUses: number;
  readonly #maxAge: number;
  readonly #cacheSize: number;

  constructor(
    private readonly provider: KeyProvider,
    private readonly options: FieldCipherOptions,
  ) {
    this.#maxUses = options.maxUsesPerKey ?? 100_000;
    this.#maxAge = options.maxKeyAgeMs ?? 60 * 60 * 1000;
    this.#cacheSize = options.cacheSize ?? 1_000;
  }

  async encrypt(plaintext: string, aad: string): Promise<Buffer> {
    const key = await this.#activeKey();
    key.uses += 1;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key.plaintext, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const header = Buffer.alloc(3);
    header.writeUInt8(VERSION, 0);
    header.writeUInt16BE(key.wrapped.length, 1);
    return Buffer.concat([header, key.wrapped, iv, cipher.getAuthTag(), ct]);
  }

  async decrypt(blob: Buffer, aad: string): Promise<string> {
    if (blob.length < 3 || blob.readUInt8(0) !== VERSION) throw new Error('Formato de cifrado no soportado');
    const wrappedLen = blob.readUInt16BE(1);
    let offset = 3;
    const wrapped = blob.subarray(offset, (offset += wrappedLen));
    const iv = blob.subarray(offset, (offset += IV_LEN));
    const tag = blob.subarray(offset, (offset += TAG_LEN));
    const ct = blob.subarray(offset);
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new Error('Texto cifrado truncado');

    const dek = await this.#unwrap(wrapped);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  async #activeKey(): Promise<ActiveKey> {
    const k = this.#active;
    if (k && k.uses < this.#maxUses && Date.now() - k.createdAt < this.#maxAge) return k;
    // Evita que peticiones concurrentes generen varias DEK a la vez.
    this.#pending ??= this.provider
      .generateDataKey(this.options.context)
      .then((dk) => {
        const fresh = { ...dk, uses: 0, createdAt: Date.now() };
        this.#active = fresh;
        this.#remember(dk.wrapped, dk.plaintext);
        return fresh;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  async #unwrap(wrapped: Buffer): Promise<Buffer> {
    const id = createHash('sha256').update(wrapped).digest('base64');
    const hit = this.#cache.get(id);
    if (hit) return hit;
    const dek = await this.provider.unwrapDataKey(wrapped, this.options.context);
    this.#remember(wrapped, dek);
    return dek;
  }

  #remember(wrapped: Buffer, dek: Buffer) {
    const id = createHash('sha256').update(wrapped).digest('base64');
    if (this.#cache.size >= this.#cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(id, dek);
  }
}
