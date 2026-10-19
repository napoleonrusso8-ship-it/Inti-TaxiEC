import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccessTokenVerifier } from '@intitaxi/auth-verifier';
import {
  AccessTokenGuard,
  AttestationGuard,
  AuditService,
  DpopProofGuard,
  InfraModule,
  INTERNAL_SECRET,
  InternalAuthGuard,
  REDIS,
  ProblemFilter,
  RecentMfaGuard,
  RedisDpopReplayStore,
  RedisSessionRevocation,
} from '@intitaxi/nest-common';
import { SigningKeys } from './common/signing-keys.js';
import type { AppConfig } from './config.js';
import { AccountController } from './modules/account/account.controller.js';
import { NewDeviceNotifier } from './modules/account/new-device.notifier.js';
import { UsersRepository } from './modules/account/users.repository.js';
import { AttestationModule } from './modules/attestation/attestation.module.js';
import { DeviceKeysController } from './modules/device-keys/device-keys.controller.js';
import { HealthController } from './modules/health.controller.js';
import { OtpController } from './modules/otp/otp.controller.js';
import { OtpService } from './modules/otp/otp.service.js';
import { PasskeysController } from './modules/passkeys/passkeys.controller.js';
import { SessionsController } from './modules/sessions/sessions.controller.js';
import { EmailStepUpController } from './modules/step-up/email-step-up.controller.js';
import { AdminLoginController } from './modules/admin/admin-login.controller.js';
import { InternalContactController, MASKED_CALLS, MockMaskedCallProvider } from './modules/internal/contact.controller.js';
import { InternalNotifyController } from './modules/internal/notify.controller.js';
import type { Redis } from 'ioredis';
import { TokenController } from './modules/tokens/token.controller.js';
import { TokenService } from './modules/tokens/token.service.js';
import { CONFIG } from './tokens.js';

/** Servicios transversales visibles en todos los módulos. */
@Global()
@Module({
  providers: [
    { provide: SigningKeys, inject: [CONFIG], useFactory: (c: AppConfig) => SigningKeys.fromConfig(c) },
    {
      provide: AccessTokenVerifier,
      inject: [CONFIG, SigningKeys, RedisDpopReplayStore, RedisSessionRevocation],
      useFactory: (c: AppConfig, k: SigningKeys, replay: RedisDpopReplayStore, revocation: RedisSessionRevocation) =>
        new AccessTokenVerifier({ issuer: c.PUBLIC_BASE_URL, audience: c.API_AUDIENCE, keys: k.getKey, replayStore: replay, revocation }),
    },
    AuditService,
    AccessTokenGuard,
    DpopProofGuard,
    AttestationGuard,
    RecentMfaGuard,
  ],
  exports: [SigningKeys, AccessTokenVerifier, AuditService, AccessTokenGuard, DpopProofGuard, AttestationGuard, RecentMfaGuard],
})
class CommonModule {}

@Module({})
export class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    const configModule: DynamicModule = { module: class ConfigModule {}, global: true, providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] };
    return {
      module: AppModule,
      imports: [
        configModule,
        InfraModule.forRoot(config, { applicationName: 'intitaxi-auth', cipherContext: { service: 'auth', purpose: 'pii' } }),
        CommonModule,
        AttestationModule,
      ],
      controllers: [HealthController, TokenController, OtpController, AccountController, PasskeysController, DeviceKeysController, SessionsController, EmailStepUpController, AdminLoginController, InternalContactController, InternalNotifyController],
      providers: [
        { provide: APP_FILTER, useClass: ProblemFilter },
        { provide: INTERNAL_SECRET, useValue: Buffer.from(config.INTERNAL_SIGNING_SECRET, 'base64') },
        InternalAuthGuard,
        { provide: MASKED_CALLS, inject: [REDIS], useFactory: (r: Redis) => new MockMaskedCallProvider(r) },
        UsersRepository,
        NewDeviceNotifier,
        OtpService,
        TokenService,
      ],
    };
  }
}
