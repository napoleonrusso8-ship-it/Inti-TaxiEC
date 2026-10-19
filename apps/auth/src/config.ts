import { z } from 'zod';

const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const base64Key = (minBytes: number) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length >= minBytes, `debe ser base64 de al menos ${minBytes} bytes`);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3001),
    /** URL pública canónica del servicio. Se usa para validar `htu` de DPoP; nunca se deriva de la cabecera Host. */
    PUBLIC_BASE_URL: z.string().url(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL_CA: z.string().optional(),
    REDIS_URL: z.string().min(1),
    REDIS_TLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

    KEY_PROVIDER: z.enum(['local', 'kms']).default('local'),
    LOCAL_MASTER_KEY: base64Key(32).optional(),
    KMS_KEY_ID: z.string().optional(),
    AWS_REGION: z.string().default('us-east-1'),
    BLIND_INDEX_KEY: base64Key(32),
    OTP_PEPPER: base64Key(32),

    JWT_SIGNING_KEY_PEM: z.string().min(1),
    JWT_SIGNING_KID: z.string().min(1),
    /** JWKS (JSON) con claves públicas anteriores, para rotar sin invalidar tokens vigentes. */
    JWT_PREVIOUS_PUBLIC_JWKS: z.string().default('{"keys":[]}'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    API_AUDIENCE: z.string().default('intitaxi-api'),
    CLIENT_IDS: csv.default('intitaxi-passenger,intitaxi-driver'),

    ATTESTATION_MODE: z.enum(['enforce', 'dev']).default('enforce'),
    ANDROID_PACKAGE_NAMES: csv.default('ec.intitaxi.passenger,ec.intitaxi.driver'),
    ANDROID_CERT_SHA256: csv.default(''),
    PLAY_INTEGRITY_CREDENTIALS_FILE: z.string().optional(),

    WEBAUTHN_RP_ID: z.string().default('intitaxi.ec'),
    WEBAUTHN_RP_NAME: z.string().default('Inti Taxi'),
    WEBAUTHN_ORIGINS: csv,

    SMS_PROVIDER: z.enum(['console', 'capture']).default('console'),
    EMAIL_PROVIDER: z.enum(['console', 'capture']).default('console'),
    EMAIL_VERIFY_URL: z.string().url().default('https://intitaxi.ec/verificar-correo'),
  })
  .superRefine((c, ctx) => {
    if (c.KEY_PROVIDER === 'local' && !c.LOCAL_MASTER_KEY) {
      ctx.addIssue({ code: 'custom', path: ['LOCAL_MASTER_KEY'], message: 'requerida con KEY_PROVIDER=local' });
    }
    if (c.KEY_PROVIDER === 'kms' && !c.KMS_KEY_ID) {
      ctx.addIssue({ code: 'custom', path: ['KMS_KEY_ID'], message: 'requerida con KEY_PROVIDER=kms' });
    }
    if (c.NODE_ENV !== 'production') return;
    // Salvaguardas de producción: la app no arranca con configuraciones inseguras.
    const prod = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message: `producción: ${message}` });
    };
    prod(c.KEY_PROVIDER === 'kms', 'KEY_PROVIDER', 'debe ser kms');
    prod(c.ATTESTATION_MODE === 'enforce', 'ATTESTATION_MODE', 'debe ser enforce');
    prod(c.PUBLIC_BASE_URL.startsWith('https://'), 'PUBLIC_BASE_URL', 'debe usar https');
    prod(!!c.DATABASE_SSL_CA, 'DATABASE_SSL_CA', 'la conexión a Postgres debe usar TLS');
    prod(c.REDIS_TLS, 'REDIS_TLS', 'la conexión a Redis debe usar TLS');
    prod(c.ANDROID_CERT_SHA256.length > 0, 'ANDROID_CERT_SHA256', 'falta la huella del certificado de firma');
    prod(!!c.PLAY_INTEGRITY_CREDENTIALS_FILE, 'PLAY_INTEGRITY_CREDENTIALS_FILE', 'faltan credenciales de Play Integrity');
    prod(c.SMS_PROVIDER !== 'console' && c.SMS_PROVIDER !== 'capture', 'SMS_PROVIDER', 'no se permite el proveedor de consola');
    prod(c.EMAIL_PROVIDER !== 'console' && c.EMAIL_PROVIDER !== 'capture', 'EMAIL_PROVIDER', 'no se permite el proveedor de consola');
    prod(c.WEBAUTHN_ORIGINS.every((o) => o.startsWith('https://') || o.startsWith('android:apk-key-hash:')), 'WEBAUTHN_ORIGINS', 'orígenes no seguros');
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Solo se listan nombres de variables y motivos, nunca sus valores.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  return parsed.data;
}
