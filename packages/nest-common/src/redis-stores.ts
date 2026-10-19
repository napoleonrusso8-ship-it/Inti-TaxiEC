import type { Redis } from 'ioredis';
import type { DpopReplayStore, SessionRevocationChecker } from '@intitaxi/auth-verifier';

export class RedisDpopReplayStore implements DpopReplayStore {
  constructor(private readonly redis: Redis) {}
  async markUsed(jti: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(`dpop:jti:${jti}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }
}

/**
 * Lista de sesiones revocadas para cortar tokens de acceso aún vigentes (viven ≤ 15 min).
 * La fuente de verdad es identity.sessions; Redis solo acelera la comprobación por petición.
 */
export class RedisSessionRevocation implements SessionRevocationChecker {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}
  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(`revoked:sid:${sessionId}`)) === 1;
  }
  async revoke(sessionId: string): Promise<void> {
    await this.redis.set(`revoked:sid:${sessionId}`, '1', 'EX', this.ttlSeconds);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Límite de ventana fija por clave (INCR + EXPIRE NX, atómico vía MULTI). */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const k = `rl:${key}:${windowSeconds}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSeconds, 'NX').ttl(k).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSeconds);
    return { allowed: count <= limit, retryAfterSeconds: count <= limit ? 0 : Math.max(ttl, 1) };
  }
}

/** Bloqueo progresivo: 5 fallos → 15 min, 10 → 1 h, 15 o más → 24 h. Los fallos se olvidan a las 24 h. */
export function lockoutSecondsFor(failures: number): number {
  if (failures >= 15) return 24 * 3600;
  if (failures >= 10) return 3600;
  if (failures >= 5) return 15 * 60;
  return 0;
}

export class ProgressiveLockout {
  constructor(private readonly redis: Redis) {}

  async lockedFor(scope: string): Promise<number> {
    const ttl = await this.redis.ttl(`lock:until:${scope}`);
    return ttl > 0 ? ttl : 0;
  }

  async recordFailure(scope: string): Promise<number> {
    const k = `lock:fails:${scope}`;
    const res = await this.redis.multi().incr(k).expire(k, 24 * 3600).exec();
    const failures = Number(res?.[0]?.[1] ?? 0);
    const lock = failures % 5 === 0 ? lockoutSecondsFor(failures) : 0;
    if (lock > 0) await this.redis.set(`lock:until:${scope}`, '1', 'EX', lock);
    return lock;
  }

  async reset(scope: string): Promise<void> {
    await this.redis.del(`lock:fails:${scope}`, `lock:until:${scope}`);
  }
}

/** Valores de un solo uso con expiración (códigos de autorización, retos WebAuthn, nonces). */
export class OneTimeStore {
  constructor(private readonly redis: Redis) {}
  async put(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(`once:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
  }
  async take<T>(key: string): Promise<T | null> {
    const raw = await this.redis.getdel(`once:${key}`);
    return raw === null ? null : (JSON.parse(raw) as T);
  }
}
