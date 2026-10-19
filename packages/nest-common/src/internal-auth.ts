import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { constantTimeEqual, randomToken, sha256Base64Url } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';
import { AppError } from './errors.js';
import type { AppRequest } from './request.js';
import { REDIS } from './tokens.js';

export const INTERNAL_SECRET = Symbol('INTERNAL_SECRET');

const canonical = (service: string, ts: string, nonce: string, method: string, path: string, body: string) =>
  [service, ts, nonce, method.toUpperCase(), path, sha256Base64Url(body)].join('\n');

/**
 * Firma de peticiones entre servicios (defensa en profundidad además de mTLS en la malla).
 * HMAC-SHA256 sobre servicio, marca de tiempo, nonce, método, ruta y hash del cuerpo.
 */
export function signInternal(secret: Buffer, service: string, method: string, path: string, body = ''): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomToken(16);
  const sig = createHmac('sha256', secret).update(canonical(service, ts, nonce, method, path, body)).digest('base64url');
  return { 'X-Internal-Service': service, 'X-Internal-Timestamp': ts, 'X-Internal-Nonce': nonce, 'X-Internal-Signature': sig };
}

/** Cliente HTTP interno firmado. */
export async function internalFetch(secret: Buffer, service: string, baseUrl: string, method: string, path: string, body?: unknown) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(baseUrl + path, {
    method,
    headers: { ...signInternal(secret, service, method, path, payload), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload || undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Acepta solo peticiones firmadas por servicios permitidos, en ±60 s y sin repetir el nonce. */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    @Inject(INTERNAL_SECRET) private readonly secret: Buffer,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const deny = () => new AppError(401, 'unauthorized', 'No autorizado');
    const service = req.header('x-internal-service') ?? '';
    const ts = req.header('x-internal-timestamp') ?? '';
    const nonce = req.header('x-internal-nonce') ?? '';
    const sig = req.header('x-internal-signature') ?? '';
    if (!['api', 'sos', 'realtime', 'workers'].includes(service) || !/^\d+$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw deny();
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) throw deny();
    const body = req.rawBody ? req.rawBody.toString('utf8') : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
    const expected = createHmac('sha256', this.secret).update(canonical(service, ts, nonce, req.method, req.originalUrl, body)).digest('base64url');
    if (!constantTimeEqual(Buffer.from(sig), Buffer.from(expected))) throw deny();
    if ((await this.redis.set(`internal:nonce:${nonce}`, '1', 'EX', 120, 'NX')) !== 'OK') throw deny();
    return true;
  }
}
