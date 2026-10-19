import { type DynamicModule, Module } from '@nestjs/common';
import { REDIS } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config.js';
import { ECU911 } from '../../tokens.js';
import { AgreementEcu911Adapter, MockEcu911Adapter, SignedLinkEcu911Adapter } from './ecu911.js';
import { ManifestLifecycle, ManifestService } from './manifest.service.js';
import { AdminSafetyController, AuthorityController, DevEcu911Controller, SosController } from './safety.controller.js';
import { SosService } from './sos.service.js';

/** Manifiesto: en el servicio api (versiones al iniciar/terminar) y en el servicio sos (incidentes). */
@Module({})
export class ManifestModule {
  static forRole(role: 'api' | 'sos'): DynamicModule {
    return {
      module: ManifestModule,
      global: true,
      providers: [ManifestService, ...(role === 'api' ? [ManifestLifecycle] : [])],
      exports: [ManifestService],
    };
  }
}

/** SOS, incidentes, ECU 911 y entregas a autoridades: SOLO en el servicio sos (despliegue aislado). */
@Module({})
export class SosModule {
  static forConfig(c: AppConfig): DynamicModule {
    return {
      module: SosModule,
      controllers: [SosController, AdminSafetyController, AuthorityController, ...(c.DEV_TOOLS ? [DevEcu911Controller] : [])],
      providers: [
        {
          provide: ECU911,
          inject: [REDIS],
          useFactory: (r: Redis) =>
            c.ECU911_ADAPTER === 'agreement'
              ? new AgreementEcu911Adapter(c.ECU911_ENDPOINT!, { cert: c.ECU911_CLIENT_CERT_FILE!, key: c.ECU911_CLIENT_KEY_FILE!, ca: c.ECU911_CA_FILE })
              : c.ECU911_ADAPTER === 'signed_link'
                ? new SignedLinkEcu911Adapter()
                : new MockEcu911Adapter(r),
        },
        SosService,
      ],
    };
  }
}
