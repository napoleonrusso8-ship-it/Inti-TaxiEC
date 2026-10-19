import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { KMSClient } from '@aws-sdk/client-kms';
import { BlindIndex, FieldCipher, KmsKeyProvider, LocalKeyProvider } from '@intitaxi/crypto';
import { createPool, type Pool } from '@intitaxi/db';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { BLIND_INDEX, CLOCK, CONFIG, EMAIL_SENDER, FIELD_CIPHER, PG_POOL, REDIS, SMS_SENDER } from '../tokens.js';
import { CapturingSender, ConsoleEmailSender, ConsoleSmsSender } from './notifier.js';
import { OneTimeStore, ProgressiveLockout, RateLimiter, RedisDpopReplayStore, RedisSessionRevocation } from './redis-stores.js';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG],
      useFactory: (c: AppConfig) =>
        createPool({
          connectionString: c.DATABASE_URL,
          applicationName: 'intitaxi-auth',
          ssl: c.DATABASE_SSL_CA ? { ca: readFileSync(c.DATABASE_SSL_CA, 'utf8'), rejectUnauthorized: true } : false,
        }),
    },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (c: AppConfig) => new Redis(c.REDIS_URL, { tls: c.REDIS_TLS ? {} : undefined, lazyConnect: false }),
    },
    {
      provide: FIELD_CIPHER,
      inject: [CONFIG],
      useFactory: (c: AppConfig) => {
        const provider =
          c.KEY_PROVIDER === 'kms'
            ? new KmsKeyProvider(new KMSClient({ region: c.AWS_REGION }), c.KMS_KEY_ID!)
            : new LocalKeyProvider(c.LOCAL_MASTER_KEY!);
        return new FieldCipher(provider, { context: { service: 'auth', purpose: 'pii' } });
      },
    },
    { provide: BLIND_INDEX, inject: [CONFIG], useFactory: (c: AppConfig) => new BlindIndex(c.BLIND_INDEX_KEY) },
    {
      provide: SMS_SENDER,
      inject: [CONFIG],
      useFactory: (c: AppConfig) => (c.SMS_PROVIDER === 'capture' ? new CapturingSender() : new ConsoleSmsSender()),
    },
    {
      provide: EMAIL_SENDER,
      inject: [CONFIG],
      useFactory: (c: AppConfig) => (c.EMAIL_PROVIDER === 'capture' ? new CapturingSender() : new ConsoleEmailSender()),
    },
    { provide: CLOCK, useValue: () => new Date() },
    { provide: RedisDpopReplayStore, inject: [REDIS], useFactory: (r: Redis) => new RedisDpopReplayStore(r) },
    {
      provide: RedisSessionRevocation,
      inject: [REDIS, CONFIG],
      useFactory: (r: Redis, c: AppConfig) => new RedisSessionRevocation(r, c.ACCESS_TOKEN_TTL_SECONDS + 60),
    },
    { provide: RateLimiter, inject: [REDIS], useFactory: (r: Redis) => new RateLimiter(r) },
    { provide: ProgressiveLockout, inject: [REDIS], useFactory: (r: Redis) => new ProgressiveLockout(r) },
    { provide: OneTimeStore, inject: [REDIS], useFactory: (r: Redis) => new OneTimeStore(r) },
  ],
  exports: [
    PG_POOL, REDIS, FIELD_CIPHER, BLIND_INDEX, SMS_SENDER, EMAIL_SENDER, CLOCK,
    RedisDpopReplayStore, RedisSessionRevocation, RateLimiter, ProgressiveLockout, OneTimeStore,
  ],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown() {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
