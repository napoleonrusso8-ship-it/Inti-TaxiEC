import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { KMSClient } from '@aws-sdk/client-kms';
import { BlindIndex, FieldCipher, KmsKeyProvider, LocalKeyProvider, type KeyProvider } from '@intitaxi/crypto';
import { createPool, type Pool } from '@intitaxi/db';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import type { InfraConfig } from './config.js';
import {
  CapturingSender,
  ConsoleEmailSender,
  ConsoleSmsSender,
  DevboxSender,
  InfobipSmsSender,
  SesEmailSender,
} from './notifier.js';
import { OneTimeStore, ProgressiveLockout, RateLimiter, RedisDpopReplayStore, RedisSessionRevocation } from './redis-stores.js';
import { BLIND_INDEX, EMAIL_SENDER, FIELD_CIPHER, INFRA_CONFIG, PG_POOL, PUBLIC_BASE_URL, REDIS, SMS_SENDER } from './tokens.js';

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

export function keyProviderFor(c: InfraConfig): KeyProvider {
  return c.KEY_PROVIDER === 'kms' ? new KmsKeyProvider(new KMSClient({ region: c.AWS_REGION }), c.KMS_KEY_ID!) : new LocalKeyProvider(c.LOCAL_MASTER_KEY!);
}

/**
 * Infraestructura común (BD, Redis, cifrado, notificaciones, límites). Global.
 * `cipherContext` identifica el dominio de datos del servicio (contexto de cifrado KMS).
 */
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  static forRoot(config: InfraConfig, opts: { applicationName: string; cipherContext: Record<string, string> }): DynamicModule {
    const providers = [
      { provide: INFRA_CONFIG, useValue: config },
      { provide: PUBLIC_BASE_URL, useValue: config.PUBLIC_BASE_URL },
      {
        provide: PG_POOL,
        useFactory: () =>
          createPool({
            connectionString: config.DATABASE_URL,
            applicationName: opts.applicationName,
            ssl: config.DATABASE_SSL_CA ? { ca: readFileSync(config.DATABASE_SSL_CA, 'utf8'), rejectUnauthorized: true } : false,
          }),
      },
      { provide: REDIS, useFactory: () => new Redis(config.REDIS_URL, { tls: config.REDIS_TLS ? {} : undefined }) },
      { provide: KEY_PROVIDER, useFactory: () => keyProviderFor(config) },
      { provide: FIELD_CIPHER, inject: [KEY_PROVIDER], useFactory: (p: KeyProvider) => new FieldCipher(p, { context: opts.cipherContext }) },
      { provide: BLIND_INDEX, useFactory: () => new BlindIndex(config.BLIND_INDEX_KEY) },
      {
        provide: SMS_SENDER,
        inject: [REDIS],
        useFactory: (r: Redis) => {
          switch (config.SMS_PROVIDER) {
            case 'infobip':
              return new InfobipSmsSender(config.INFOBIP_BASE_URL!, config.INFOBIP_API_KEY!, config.INFOBIP_SENDER);
            case 'devbox':
              return new DevboxSender(r, 'sms');
            case 'capture':
              return new CapturingSender();
            default:
              return new ConsoleSmsSender();
          }
        },
      },
      {
        provide: EMAIL_SENDER,
        inject: [REDIS],
        useFactory: (r: Redis) => {
          switch (config.EMAIL_PROVIDER) {
            case 'ses':
              return SesEmailSender.create(config.AWS_REGION, config.SES_FROM!, config.SES_CONFIGURATION_SET);
            case 'devbox':
              return new DevboxSender(r, 'email');
            case 'capture':
              return new CapturingSender();
            default:
              return new ConsoleEmailSender();
          }
        },
      },
      { provide: RedisDpopReplayStore, inject: [REDIS], useFactory: (r: Redis) => new RedisDpopReplayStore(r) },
      { provide: RedisSessionRevocation, inject: [REDIS], useFactory: (r: Redis) => new RedisSessionRevocation(r, config.ACCESS_TOKEN_TTL_SECONDS + 60) },
      { provide: RateLimiter, inject: [REDIS], useFactory: (r: Redis) => new RateLimiter(r) },
      { provide: ProgressiveLockout, inject: [REDIS], useFactory: (r: Redis) => new ProgressiveLockout(r) },
      { provide: OneTimeStore, inject: [REDIS], useFactory: (r: Redis) => new OneTimeStore(r) },
    ];
    return { module: InfraModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown() {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
