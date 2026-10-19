import { DeleteObjectCommand, GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { constantTimeEqual } from '@intitaxi/crypto';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface UploadInstructions {
  method: 'POST' | 'PUT';
  url: string;
  /** Campos de formulario (POST prefirmado de S3) o cabeceras (PUT local). */
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  expiresIn: number;
}

/**
 * Almacenamiento de documentos privados. Nunca se sirven desde nuestro dominio ni son públicos:
 * subida y lectura solo con URLs firmadas de corta duración.
 */
export interface StoragePort {
  createUpload(key: string, contentType: string, maxBytes: number): Promise<UploadInstructions>;
  /** Escritura directa desde el servidor (p. ej. audio cifrado de un SOS). */
  put(key: string, data: Buffer): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  createDownloadUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  /** Resultado del antimalware del almacenamiento (en S3: GuardDuty Malware Protection etiqueta el objeto). */
  scanStatus(key: string): Promise<'clean' | 'infected' | 'pending'>;
}

/** S3 (bucket privado con Block Public Access, SSE-KMS y escaneo de malware de GuardDuty). */
export class S3Storage implements StoragePort {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly kmsKeyId?: string,
  ) {}

  async createUpload(key: string, contentType: string, maxBytes: number): Promise<UploadInstructions> {
    const p = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      // POST prefirmado: a diferencia de PUT, permite imponer tamaño y tipo en la política firmada.
      Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
      Fields: { 'Content-Type': contentType, ...(this.kmsKeyId ? { 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': this.kmsKeyId } : {}) },
      Expires: 300,
    });
    return { method: 'POST', url: p.url, fields: p.fields, expiresIn: 300 };
  }

  async put(key: string, data: Buffer) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ...(this.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId } : {}) }));
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async read(key: string, maxBytes: number) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  createDownloadUrl(key: string, ttlSeconds: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: 'attachment' }), { expiresIn: ttlSeconds });
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async scanStatus(key: string) {
    const r = await this.s3.send(new GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }));
    const tag = r.TagSet?.find((t) => t.Key === 'GuardDutyMalwareScanStatus')?.Value;
    return tag === 'NO_THREATS_FOUND' ? 'clean' : tag === 'THREATS_FOUND' ? 'infected' : 'pending';
  }
}

/**
 * Almacenamiento local para desarrollo/simulador: archivos en disco y URLs firmadas con HMAC
 * servidas por /v1/dev/storage (solo con DEV_TOOLS). Prohibido en producción.
 */
export class LocalStorage implements StoragePort {
  constructor(
    private readonly dir: string,
    private readonly baseUrl: string,
    private readonly secret: Buffer,
  ) {}

  #path(key: string) {
    const p = resolve(this.dir, key);
    if (!p.startsWith(resolve(this.dir) + '/')) throw new Error('clave de almacenamiento inválida');
    return p;
  }

  sign(op: 'put' | 'get', key: string, exp: number, extra = '') {
    return createHmac('sha256', this.secret).update(`${op}\n${key}\n${exp}\n${extra}`).digest('base64url');
  }

  verify(op: 'put' | 'get', key: string, exp: number, sig: string, extra = '') {
    return exp > Date.now() / 1000 && constantTimeEqual(Buffer.from(sig), Buffer.from(this.sign(op, key, exp, extra)));
  }

  async createUpload(key: string, contentType: string, maxBytes: number): Promise<UploadInstructions> {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const extra = `${contentType}\n${maxBytes}`;
    const q = new URLSearchParams({ key, exp: String(exp), ct: contentType, max: String(maxBytes), sig: this.sign('put', key, exp, extra) });
    return { method: 'PUT', url: `${this.baseUrl}/v1/dev/storage?${q}`, headers: { 'Content-Type': contentType }, expiresIn: 300 };
  }

  async put(key: string, data: Buffer) {
    await this.write(key, data);
  }

  async write(key: string, data: Buffer) {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }

  async head(key: string) {
    try {
      return { size: (await stat(this.#path(key))).size };
    } catch {
      return null;
    }
  }

  async read(key: string, maxBytes: number) {
    return (await readFile(this.#path(key))).subarray(0, maxBytes);
  }

  async createDownloadUrl(key: string, ttlSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.baseUrl}/v1/dev/storage?${new URLSearchParams({ key, exp: String(exp), sig: this.sign('get', key, exp) })}`;
  }

  async delete(key: string) {
    await rm(this.#path(key), { force: true });
  }

  /** En local no hay antimalware de almacenamiento: la inspección propia (incl. EICAR) decide. */
  async scanStatus() {
    return 'clean' as const;
  }
}

export const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest();
export { join };
