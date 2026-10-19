import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { ATTESTATION_VERIFIERS, CONFIG } from '../../tokens.js';
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
      inject: [CONFIG],
      useFactory: (c: AppConfig) => {
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
          ios: new PendingAppAttestVerifier(),
        };
      },
    },
  ],
})
export class AttestationModule {}
