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
      ],
      exports: [CONFIG, AccessTokenVerifier, AuditService, AccessTokenGuard, DpopProofGuard, AttestationGuard, RecentMfaGuard],
    })
    class CoreModule {}

    // El servicio SOS se despliega aparte (aislamiento de fallos y credenciales) y solo carga sus módulos.
    const domain = role === 'api' ? [KycModule.forConfig(config)] : [];
    return {
      module: AppModule,
      imports: [
        InfraModule.forRoot(config, { applicationName: `intitaxi-${role}`, cipherContext: { service: 'api', purpose: 'pii' } }),
        CoreModule,
        ...domain,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
