import { z } from 'zod';

export const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
export const base64Key = (minBytes: number) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length >= minBytes, `debe ser base64 de al menos ${minBytes} bytes`);

/** Variables comunes a todos los servicios (BD, Redis, cifrado, notificaciones). */
export const infraEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  /** URL pública canónica del servicio. Se usa para validar `htu` de DPoP; nunca se deriva de la cabecera Host. */
  PUBLIC_BASE_URL: z.string().url(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  /** Orígenes del navegador autorizados (solo el panel de administración). Vacío = sin CORS. */
  CORS_ORIGINS: csv.default(''),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA: z.string().optional(),
  REDIS_URL: z.string().min(1),
  REDIS_TLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  KEY_PROVIDER: z.enum(['local', 'kms']).default('local'),
  LOCAL_MASTER_KEY: base64Key(32).optional(),
  KMS_KEY_ID: z.string().optional(),
  AWS_REGION: z.string().default('us-east-1'),
  BLIND_INDEX_KEY: base64Key(32),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),

  /** console / capture / devbox: solo desarrollo y pruebas. */
  SMS_PROVIDER: z.enum(['infobip', 'devbox', 'console', 'capture']).default('console'),
  INFOBIP_BASE_URL: z.string().url().optional(),
  INFOBIP_API_KEY: z.string().optional(),
  INFOBIP_SENDER: z.string().default('IntiTaxi'),
  EMAIL_PROVIDER: z.enum(['ses', 'devbox', 'console', 'capture']).default('console'),
  SES_FROM: z.string().email().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
};

export const infraEnvSchema = z.object(infraEnvShape);
export type InfraConfig = z.infer<typeof infraEnvSchema>;

type Issue = (ok: boolean, path: string, message: string) => void;

/** Reglas comunes de configuración; en producción impiden arrancar con ajustes inseguros. */
export function checkInfraConfig(c: InfraConfig, addIssue: (path: string, message: string) => void) {
  if (c.KEY_PROVIDER === 'local' && !c.LOCAL_MASTER_KEY) addIssue('LOCAL_MASTER_KEY', 'requerida con KEY_PROVIDER=local');
  if (c.KEY_PROVIDER === 'kms' && !c.KMS_KEY_ID) addIssue('KMS_KEY_ID', 'requerida con KEY_PROVIDER=kms');
  if (c.SMS_PROVIDER === 'infobip' && (!c.INFOBIP_BASE_URL || !c.INFOBIP_API_KEY)) addIssue('INFOBIP_API_KEY', 'requerida con SMS_PROVIDER=infobip');
  if (c.EMAIL_PROVIDER === 'ses' && !c.SES_FROM) addIssue('SES_FROM', 'requerida con EMAIL_PROVIDER=ses');
  if (c.NODE_ENV !== 'production') return;
  const prod: Issue = (ok, path, message) => {
    if (!ok) addIssue(path, `producción: ${message}`);
  };
  prod(c.KEY_PROVIDER === 'kms', 'KEY_PROVIDER', 'debe ser kms');
  prod(c.PUBLIC_BASE_URL.startsWith('https://'), 'PUBLIC_BASE_URL', 'debe usar https');
  prod(c.CORS_ORIGINS.every((o) => o.startsWith('https://')), 'CORS_ORIGINS', 'solo orígenes https');
  prod(!!c.DATABASE_SSL_CA, 'DATABASE_SSL_CA', 'la conexión a Postgres debe usar TLS');
  prod(c.REDIS_TLS, 'REDIS_TLS', 'la conexión a Redis debe usar TLS');
  prod(c.SMS_PROVIDER === 'infobip', 'SMS_PROVIDER', 'no se permite el proveedor de consola/devbox');
  prod(c.EMAIL_PROVIDER === 'ses', 'EMAIL_PROVIDER', 'no se permite el proveedor de consola/devbox');
}

/** Valida el entorno con un esquema zod sin incluir nunca valores en el mensaje de error. */
export function parseEnv<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv): z.output<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${issues}`);
  }
  return parsed.data;
}
