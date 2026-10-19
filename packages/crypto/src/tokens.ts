import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token opaco aleatorio (256 bits) en base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hash para almacenar tokens opacos: nunca se guarda el token en claro. */
export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
