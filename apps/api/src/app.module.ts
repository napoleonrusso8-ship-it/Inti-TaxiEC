import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AccessTokenVerifier } from '@intitaxi/auth-verifier';
import {
  AccessTokenGuard,
  AttestationGuard,
  AuditService,
  DpopProofGuard,
  InfraModule,
  ProblemFilter,
  RecentMfaGuard,
  RedisDpopReplayStore,
  RedisSessionRevocation,
} from '@intitaxi/nest-common';
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet } from 'jose';
import type { AppConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { KycModule } from './modules/kyc/kyc.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { TripsModule } from './modules/trips/trips.module.js';
import { NotificationsModule } from './modules/notifications/notifications.service.js';
import { PeopleModule } from './modules/people/people.module.js';
import { DevJobsController } from './modules/dev/dev-jobs.controller.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ManifestModule, SosModule } from './modules/safety/safety.module.js';
import { AssistModule } from './modules/assist/assist.module.js';
import { TrustModule } from './modules/trust/trust.module.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { BackofficeModule } from './modules/backoffice/backoffice.module.js';
import { FixedRoutesModule } from './modules/fixed-routes/fixed-routes.module.js';
import { AdminGuard } from './modules/admin/admin.guard.js';
import { LocalStorage, S3Storage } from './infra/storage.js';
import { S3Client } from '@aws-sdk/client-s3';
import { randomBytes } from 'node:crypto';
import { STORAGE } from './tokens.js';
import { TripEvents } from './modules/trips/trip-events.js';
import { CONFIG } from './tokens.js';

export type ServiceRole = 'api' | 'sos';

@Module({})
export class AppModule {
  static forConfig(config: AppConfig, role: ServiceRole = 'api'): DynamicModule {
    @Global()
    @Module({
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: AccessTokenVerifier,
          inject: [RedisDpopReplayStore, RedisSessionRevocation],
          useFactory: (replay: RedisDpopReplayStore, revocation: RedisSessionRevocation) =>
            new AccessTokenVerifier({
              issuer: config.AUTH_ISSUER,
              audience: config.API_AUDIENCE,
              keys: config.AUTH_JWKS_JSON
                ? createLocalJWKSet(JSON.parse(config.AUTH_JWKS_JSON) as JSONWebKeySet)
                : createRemoteJWKSet(new URL(config.AUTH_JWKS_URL!), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }),
              replayStore: replay,
              revocation,
            }),
        },
        AuditService,
        AccessTokenGuard,
        DpopProofGuard,
        AttestationGuard,
        RecentMfaGuard,
        AdminGuard,
        {
          provide: STORAGE,
          useFactory: () =>
            config.STORAGE_DRIVER === 's3'
              ? new S3Storage(new S3Client({ region: config.AWS_REGION }), config.S3_BUCKET!, config.S3_KMS_KEY_ID)
              : new LocalStorage(config.LOCAL_STORAGE_DIR, config.PUBLIC_BASE_URL, devStorageSecret),
        },
        // En el servicio sos no hay módulo de viajes: el ciclo de vida del manifiesto solo corre en api.
        { provide: 'TRIP_EVENTS_OPTIONAL', useFactory: (e?: TripEvents) => e ?? null, inject: [{ token: TripEvents, optional: true }] },
      ],
      exports: [CONFIG, AccessTokenVerifier, AuditService, AccessTokenGuard, DpopProofGuard, AttestationGuard, RecentMfaGuard, AdminGuard, STORAGE, 'TRIP_EVENTS_OPTIONAL'],
    })
    class CoreModule {}

    // El servicio SOS se despliega aparte (aislamiento de fallos y credenciales) y solo carga sus módulos.
    const devStorageSecret = randomBytes(32);
    const domain = role === 'api' ? [ManifestModule.forRole('api'), KycModule.forConfig(config), DriversModule.forConfig(config), TripsModule.forConfig(config), NotificationsModule, PeopleModule, PaymentsModule.forConfig(config), FixedRoutesModule, BackofficeModule, ChatModule, TrustModule, AssistModule] : [ManifestModule.forRole('sos'), SosModule.forConfig(config)];
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(config, { applicationName: `intitaxi-${role}`, cipherContext: { service: 'api', purpose: 'pii' } }),
        CoreModule,
        ...domain,
      ],
      controllers: [HealthController, ...(config.DEV_TOOLS && role === 'api' ? [DevJobsController] : [])],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
