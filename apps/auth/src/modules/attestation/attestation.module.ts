import { Module } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../../config.js';
import { ATTESTATION_VERIFIERS, CONFIG, PG_POOL } from '../../tokens.js';
import { AppAttestVerifier } from './app-attest.js';
import { PgAppAttestKeyStore } from './app-attest.store.js';
import { AttestationController } from './attestation.controller.js';
import {
  DevAttestationVerifier,
  googlePlayIntegrityDecoder,
  PendingAppAttestVerifier,
  PlayIntegrityVerifier,
} from './verifiers.js';

@Module({
  controllers: [AttestationController],
  providers: [
    {
      provide: ATTESTATION_VERIFIERS,
      inject: [CONFIG, PG_POOL],
      useFactory: (c: AppConfig, pool: Pool) => {
        if (c.ATTESTATION_MODE === 'dev') {
          const dev = new DevAttestationVerifier(c.PLAY_INTEGRITY_ALLOW_BASIC_PACKAGES);
          return { android: dev, ios: dev };
        }
        if (!c.PLAY_INTEGRITY_CREDENTIALS_FILE) throw new Error('Falta PLAY_INTEGRITY_CREDENTIALS_FILE');
        return {
          android: new PlayIntegrityVerifier(googlePlayIntegrityDecoder(c.PLAY_INTEGRITY_CREDENTIALS_FILE), {
            packageNames: c.ANDROID_PACKAGE_NAMES,
            certSha256: c.ANDROID_CERT_SHA256,
            allowBasicIntegrityPackages: c.PLAY_INTEGRITY_ALLOW_BASIC_PACKAGES,
            maxAgeMs: 2 * 60 * 1000,
          }),
          // Sin configuración de App Attest, iOS falla cerrado.
          ios:
            c.APP_ATTEST_ROOT_CA_FILE && c.APP_ATTEST_APP_IDS.length
              ? new AppAttestVerifier(new PgAppAttestKeyStore(pool), {
                  appIds: c.APP_ATTEST_APP_IDS,
                  rootCaPem: readFileSync(c.APP_ATTEST_ROOT_CA_FILE, 'utf8'),
                  environment: c.APP_ATTEST_ENVIRONMENT,
                })
              : new PendingAppAttestVerifier(),
        };
      },
    },
  ],
})
export class AttestationModule {}
