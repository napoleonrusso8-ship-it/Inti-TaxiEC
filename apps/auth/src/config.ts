import { base64Key, checkInfraConfig, csv, infraEnvShape, parseEnv } from '@intitaxi/nest-common';
import { z } from 'zod';

const schema = z
  .object({
    ...infraEnvShape,
    OTP_PEPPER: base64Key(32),

    JWT_SIGNING_KEY_PEM: z.string().min(1),
    JWT_SIGNING_KID: z.string().min(1),
    /** JWKS (JSON) con claves públicas anteriores, para rotar sin invalidar tokens vigentes. */
    JWT_PREVIOUS_PUBLIC_JWKS: z.string().default('{"keys":[]}'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    API_AUDIENCE: z.string().default('intitaxi-api'),
    CLIENT_IDS: csv.default('intitaxi-passenger,intitaxi-driver,intitaxi-admin'),

    ATTESTATION_MODE: z.enum(['enforce', 'dev']).default('enforce'),
    ANDROID_PACKAGE_NAMES: csv.default('ec.intitaxi.passenger,ec.intitaxi.driver'),
    ANDROID_CERT_SHA256: csv.default(''),
    /** Paquetes donde se tolera integridad básica (Android rooteado / no certificado) con señal de riesgo. */
    PLAY_INTEGRITY_ALLOW_BASIC_PACKAGES: csv.default('ec.intitaxi.passenger'),
    PLAY_INTEGRITY_CREDENTIALS_FILE: z.string().optional(),
    /** App Attest: "<TEAMID>.<bundle id>" separados por comas. */
    APP_ATTEST_APP_IDS: csv.default(''),
    /** Ruta al PEM de la Apple App Attestation Root CA (descargada de apple.com y fijada en la imagen). */
    APP_ATTEST_ROOT_CA_FILE: z.string().optional(),
    APP_ATTEST_ENVIRONMENT: z.enum(['production', 'development']).default('production'),

    WEBAUTHN_RP_ID: z.string().default('intitaxi.ec'),
    WEBAUTHN_RP_NAME: z.string().default('Inti Taxi'),
    WEBAUTHN_ORIGINS: csv,

    /** Secreto HMAC para llamadas entre servicios (además de mTLS). */
    INTERNAL_SIGNING_SECRET: base64Key(32),
    MASKED_CALLS_PROVIDER: z.enum(['mock']).default('mock'),
    EMAIL_VERIFY_URL: z.string().url().default('https://intitaxi.ec/verificar-correo'),
  })
  .superRefine((c, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    checkInfraConfig(c, add);
    if (c.NODE_ENV !== 'production') return;
    const prod = (ok: boolean, path: string, message: string) => !ok && add(path, `producción: ${message}`);
    prod(c.ATTESTATION_MODE === 'enforce', 'ATTESTATION_MODE', 'debe ser enforce');
    prod(c.ANDROID_CERT_SHA256.length > 0, 'ANDROID_CERT_SHA256', 'falta la huella del certificado de firma');
    prod(!!c.PLAY_INTEGRITY_CREDENTIALS_FILE, 'PLAY_INTEGRITY_CREDENTIALS_FILE', 'faltan credenciales de Play Integrity');
    prod(c.APP_ATTEST_APP_IDS.length > 0 && !!c.APP_ATTEST_ROOT_CA_FILE, 'APP_ATTEST_ROOT_CA_FILE', 'falta configuración de App Attest');
    prod(c.MASKED_CALLS_PROVIDER !== 'mock', 'MASKED_CALLS_PROVIDER', 'falta integrar un proveedor real de números enmascarados');
    prod(c.WEBAUTHN_ORIGINS.every((o) => o.startsWith('https://') || o.startsWith('android:apk-key-hash:')), 'WEBAUTHN_ORIGINS', 'orígenes no seguros');
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseEnv(schema, env);
}
