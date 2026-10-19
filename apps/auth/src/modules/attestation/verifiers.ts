import { GoogleAuth } from 'google-auth-library';
import { AppError } from '@intitaxi/nest-common';

export interface AttestationResult {
  passed: boolean;
  /** Señales de riesgo (se guardan en el dispositivo y alimentan el antifraude). */
  flags: string[];
}

export interface AttestationVerifier {
  verify(input: { appId: string; token: string; nonce: string }): Promise<AttestationResult>;
}

export interface PlayIntegrityPayload {
  requestDetails?: { requestPackageName?: string; nonce?: string; timestampMillis?: string };
  appIntegrity?: { appRecognitionVerdict?: string; packageName?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  accountDetails?: { appLicensingVerdict?: string };
}

export interface PlayIntegrityPolicy {
  packageNames: string[];
  certSha256: string[];
  /** Paquetes en los que se tolera MEETS_BASIC_INTEGRITY (con señal de riesgo) en lugar de MEETS_DEVICE_INTEGRITY. */
  allowBasicIntegrityPackages: string[];
  maxAgeMs: number;
}

/** Evalúa el veredicto descifrado de Play Integrity. Función pura: es la parte que decide y se prueba exhaustivamente. */
export function evaluatePlayIntegrity(
  p: PlayIntegrityPayload,
  expected: { appId: string; nonce: string; nowMs: number },
  policy: PlayIntegrityPolicy,
): AttestationResult {
  const fatal: string[] = [];
  const flags: string[] = [];
  const rd = p.requestDetails ?? {};
  if (rd.requestPackageName !== expected.appId || !policy.packageNames.includes(expected.appId)) fatal.push('package_mismatch');
  if (rd.nonce !== expected.nonce) fatal.push('nonce_mismatch');
  const ts = Number(rd.timestampMillis);
  if (!Number.isFinite(ts) || Math.abs(expected.nowMs - ts) > policy.maxAgeMs) fatal.push('stale_verdict');

  const ai = p.appIntegrity ?? {};
  if (ai.appRecognitionVerdict !== 'PLAY_RECOGNIZED') fatal.push('app_not_recognized');
  if (ai.packageName !== expected.appId) fatal.push('package_mismatch');
  const certs = (ai.certificateSha256Digest ?? []).map((c) => c.toLowerCase());
  if (!certs.some((c) => policy.certSha256.map((x) => x.toLowerCase()).includes(c))) fatal.push('signing_cert_mismatch');

  const dv = p.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!dv.includes('MEETS_DEVICE_INTEGRITY')) {
    if (dv.includes('MEETS_BASIC_INTEGRITY') && policy.allowBasicIntegrityPackages.includes(expected.appId)) {
      flags.push('device_integrity_basic_only');
    } else {
      fatal.push('device_integrity_failed');
    }
  }
  if (p.accountDetails?.appLicensingVerdict === 'UNLICENSED') flags.push('app_unlicensed');

  return { passed: fatal.length === 0, flags: [...new Set([...fatal, ...flags])] };
}

export type PlayIntegrityDecoder = (packageName: string, token: string) => Promise<PlayIntegrityPayload>;

/** Descifra el token en los servidores de Google con una cuenta de servicio (credenciales en Secrets Manager). */
export function googlePlayIntegrityDecoder(credentialsFile: string): PlayIntegrityDecoder {
  const auth = new GoogleAuth({ keyFile: credentialsFile, scopes: ['https://www.googleapis.com/auth/playintegrity'] });
  return async (packageName, token) => {
    const client = await auth.getClient();
    const res = await client.request<{ tokenPayloadExternal: PlayIntegrityPayload }>({
      url: `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
      method: 'POST',
      data: { integrity_token: token },
      timeout: 5000,
    });
    return res.data.tokenPayloadExternal;
  };
}

export class PlayIntegrityVerifier implements AttestationVerifier {
  constructor(
    private readonly decode: PlayIntegrityDecoder,
    private readonly policy: PlayIntegrityPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async verify({ appId, token, nonce }: { appId: string; token: string; nonce: string }) {
    if (!this.policy.packageNames.includes(appId)) return { passed: false, flags: ['package_mismatch'] };
    const payload = await this.decode(appId, token);
    return evaluatePlayIntegrity(payload, { appId, nonce, nowMs: this.now() }, this.policy);
  }
}

/**
 * App Attest (iOS) — PENDIENTE de implementar (verificación CBOR + cadena X.509 contra la
 * "Apple App Attestation Root CA" y aserciones con contador). Falla cerrado: sin esto,
 * ningún iPhone puede autenticarse en modo `enforce`.
 */
export class PendingAppAttestVerifier implements AttestationVerifier {
  async verify(): Promise<AttestationResult> {
    throw new AppError(503, 'attestation_unavailable', 'La verificación de App Attest aún no está disponible');
  }
}

/**
 * Solo desarrollo/pruebas: "dev-ok:<nonce>" = dispositivo íntegro; "dev-basic:<nonce>" = Android
 * rooteado/no certificado (aplica la misma política que Play Integrity); cualquier otro valor falla.
 */
export class DevAttestationVerifier implements AttestationVerifier {
  constructor(private readonly allowBasicIntegrityPackages: string[] = []) {}

  async verify({ appId, token, nonce }: { appId: string; token: string; nonce: string }) {
    if (token === `dev-ok:${nonce}`) return { passed: true, flags: ['dev_attestation'] };
    if (token === `dev-basic:${nonce}`) {
      return this.allowBasicIntegrityPackages.includes(appId)
        ? { passed: true, flags: ['dev_attestation', 'device_integrity_basic_only'] }
        : { passed: false, flags: ['device_integrity_failed'] };
    }
    return { passed: false, flags: ['dev_simulated_failure'] };
  }
}
