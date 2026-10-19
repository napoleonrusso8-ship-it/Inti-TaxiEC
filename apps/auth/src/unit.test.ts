import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { lockoutSecondsFor } from '@intitaxi/nest-common';
import { evaluatePlayIntegrity, type PlayIntegrityPayload, type PlayIntegrityPolicy } from './modules/attestation/verifiers.js';

const now = 1_760_000_000_000;
const policy: PlayIntegrityPolicy = {
  packageNames: ['ec.intitaxi.passenger', 'ec.intitaxi.driver'],
  certSha256: ['ABC123'],
  allowBasicIntegrityPackages: [],
  maxAgeMs: 120_000,
};
const good = (): PlayIntegrityPayload => ({
  requestDetails: { requestPackageName: 'ec.intitaxi.driver', nonce: 'n1', timestampMillis: String(now - 1000) },
  appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: 'ec.intitaxi.driver', certificateSha256Digest: ['abc123'] },
  deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  accountDetails: { appLicensingVerdict: 'LICENSED' },
});
const expected = { appId: 'ec.intitaxi.driver', nonce: 'n1', nowMs: now };

describe('evaluatePlayIntegrity', () => {
  it('aprueba un veredicto correcto', () => {
    expect(evaluatePlayIntegrity(good(), expected, policy)).toEqual({ passed: true, flags: [] });
  });

  it.each<[string, (p: PlayIntegrityPayload) => void, string]>([
    ['nonce distinto (repetición)', (p) => (p.requestDetails!.nonce = 'otro'), 'nonce_mismatch'],
    ['veredicto antiguo', (p) => (p.requestDetails!.timestampMillis = String(now - 600_000)), 'stale_verdict'],
    ['app re-empaquetada / no reconocida', (p) => (p.appIntegrity!.appRecognitionVerdict = 'UNRECOGNIZED_VERSION'), 'app_not_recognized'],
    ['firmada con otro certificado', (p) => (p.appIntegrity!.certificateSha256Digest = ['ffff']), 'signing_cert_mismatch'],
    ['dispositivo rooteado o emulador', (p) => (p.deviceIntegrity!.deviceRecognitionVerdict = ['MEETS_BASIC_INTEGRITY']), 'device_integrity_failed'],
    ['sin veredicto de dispositivo', (p) => (p.deviceIntegrity = {}), 'device_integrity_failed'],
    ['otro paquete', (p) => (p.requestDetails!.requestPackageName = 'com.evil'), 'package_mismatch'],
  ])('rechaza: %s', (_, mutate, flag) => {
    const p = good();
    mutate(p);
    const r = evaluatePlayIntegrity(p, expected, policy);
    expect(r.passed).toBe(false);
    expect(r.flags).toContain(flag);
  });

  it('tolera integridad básica solo en paquetes configurados, marcando el riesgo', () => {
    const p = good();
    p.deviceIntegrity!.deviceRecognitionVerdict = ['MEETS_BASIC_INTEGRITY'];
    const r = evaluatePlayIntegrity(p, expected, { ...policy, allowBasicIntegrityPackages: ['ec.intitaxi.driver'] });
    expect(r).toEqual({ passed: true, flags: ['device_integrity_basic_only'] });
  });
});

describe('lockoutSecondsFor', () => {
  it.each([
    [4, 0],
    [5, 900],
    [10, 3600],
    [15, 86400],
    [30, 86400],
  ])('%i fallos → %i s', (f, s) => expect(lockoutSecondsFor(f)).toBe(s));
});

describe('loadConfig', () => {
  const k = Buffer.alloc(32, 1).toString('base64');
  const base = {
    PUBLIC_BASE_URL: 'https://auth.intitaxi.ec',
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    BLIND_INDEX_KEY: k,
    OTP_PEPPER: k,
    INTERNAL_SIGNING_SECRET: k,
    JWT_SIGNING_KEY_PEM: 'pem',
    JWT_SIGNING_KID: 'k1',
    WEBAUTHN_ORIGINS: 'https://intitaxi.ec',
  };

  it('acepta configuración de desarrollo', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', LOCAL_MASTER_KEY: k })).not.toThrow();
  });

  it('impide arrancar producción con claves locales, atestación dev o proveedores de consola', () => {
    let msg = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production', LOCAL_MASTER_KEY: k, ATTESTATION_MODE: 'dev' });
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const v of ['KEY_PROVIDER', 'ATTESTATION_MODE', 'DATABASE_SSL_CA', 'REDIS_TLS', 'SMS_PROVIDER', 'EMAIL_PROVIDER', 'ANDROID_CERT_SHA256']) {
      expect(msg).toContain(v);
    }
  });

  it('no incluye valores secretos en el mensaje de error', () => {
    try {
      loadConfig({ ...base, NODE_ENV: 'production', LOCAL_MASTER_KEY: k });
    } catch (e) {
      expect((e as Error).message).not.toContain(k);
    }
  });
});
