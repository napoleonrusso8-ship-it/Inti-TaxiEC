import { type DynamicModule, Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config.js';
import { CONFIG, KYC_PROVIDER, REDIS } from '../../tokens.js';
import { DevKycController } from './dev-kyc.controller.js';
import { ConsentsController, KycController, KycWebhookController } from './kyc.controller.js';
import { KycService } from './kyc.service.js';
import { MockKycProvider, VeriffProvider } from './providers.js';

@Module({})
export class KycModule implements OnModuleInit, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  static forConfig(c: AppConfig): DynamicModule {
    return {
      module: KycModule,
      controllers: [ConsentsController, KycController, KycWebhookController, ...(c.DEV_TOOLS ? [DevKycController] : [])],
      providers: [
        KycService,
        {
          provide: KYC_PROVIDER,
          inject: [CONFIG, REDIS],
          useFactory: (cfg: AppConfig, redis: Redis) =>
            cfg.KYC_PROVIDER === 'veriff'
              ? new VeriffProvider({ baseUrl: cfg.VERIFF_BASE_URL, apiKey: cfg.VERIFF_API_KEY!, sharedSecret: cfg.VERIFF_SHARED_SECRET! })
              : new MockKycProvider(redis, Buffer.from(cfg.WEBHOOK_SECRET_KYC!, 'base64')),
        },
      ],
      exports: [KycService],
    };
  }

  onModuleInit() {
    // Borrado periódico de datos en el proveedor (en producción: tarea programada en el servicio workers).
    this.#timer = setInterval(() => void this.kyc.purgeProviderData().catch(() => {}), 15 * 60_000);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }
}
