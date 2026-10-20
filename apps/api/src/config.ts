import { base64Key, checkInfraConfig, infraEnvShape, parseEnv } from '@intitaxi/nest-common';
import { z } from 'zod';

const schema = z
  .object({
    ...infraEnvShape,
    PORT: z.coerce.number().int().default(3002),
    AUTH_ISSUER: z.string().url(),
    /** JWKS del servicio auth (en producción por red privada con mTLS). */
    AUTH_JWKS_URL: z.string().url().optional(),
    /** Alternativa para pruebas: JWKS en JSON. */
    AUTH_JWKS_JSON: z.string().optional(),
    API_AUDIENCE: z.string().default('intitaxi-api'),

    /** Habilita endpoints /v1/dev/* (simulador). Prohibido en producción. */
    DEV_TOOLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

    KYC_PROVIDER: z.enum(['veriff', 'mock']).default('mock'),
    VERIFF_BASE_URL: z.string().url().default('https://stationapi.veriff.com'),
    VERIFF_API_KEY: z.string().optional(),
    VERIFF_SHARED_SECRET: z.string().optional(),
    /** Secreto HMAC de los webhooks del proveedor simulado. */
    WEBHOOK_SECRET_KYC: base64Key(32).optional(),
    /** Días tras la decisión para pedir al proveedor que borre imágenes y vídeo. */
    KYC_PROVIDER_RETENTION_DAYS: z.coerce.number().int().min(0).max(90).default(30),
    /** Probabilidad de re-verificación aleatoria del conductor al conectarse. */
    REVERIFY_PROBABILITY: z.coerce.number().min(0).max(1).default(0.2),

    /** Documentos de conductores: "s3" en producción; "local" solo desarrollo. */
    STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
    S3_BUCKET: z.string().optional(),
    S3_KMS_KEY_ID: z.string().optional(),
    LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
    /** Antigüedad máxima del vehículo. ⚠️ Confirmar con la ATM de Guayaquil. */
    VEHICLE_MAX_AGE_YEARS: z.coerce.number().int().min(1).max(40).default(15),

    /** Llamadas firmadas a otros servicios (además de mTLS). */
    INTERNAL_SIGNING_SECRET: base64Key(32),
    INTERNAL_AUTH_URL: z.string().url(),

    /** Rutas y distancias: "google" (Routes API) en producción; "estimator" (línea recta × factor) en desarrollo. */
    MAPS_PROVIDER: z.enum(['google', 'estimator']).default('estimator'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    /** Tarifa bajo demanda (centavos). ⚠️ Valores de ejemplo: definir con negocio y ordenanza municipal. */
    FARE_BASE_CENTS: z.coerce.number().int().min(0).default(150),
    FARE_PER_KM_CENTS: z.coerce.number().int().min(0).default(40),
    FARE_PER_MIN_CENTS: z.coerce.number().int().min(0).default(10),
    FARE_MIN_CENTS: z.coerce.number().int().min(0).default(200),
    /** Tarifa dinámica (activable por ciudad/despliegue: la tarifa de taxi la regula la ATM, ver revisión legal). */
    SURGE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    SURGE_MAX: z.coerce.number().min(1).max(2).default(1.5),
    /** Compensación (la paga la plataforma) al conductor que ya había llegado cuando el pasajero pide otra unidad. */
    /** Alerta de desvío / parada larga. */
    SAFETY_CHECK_RESPONSE_SECONDS: z.coerce.number().int().min(10).max(600).default(90),
    DEVIATION_THRESHOLD_M: z.coerce.number().int().min(100).max(10_000).default(1500),
    DEVIATION_MIN_TRIP_SECONDS: z.coerce.number().int().min(0).max(1800).default(60),
    LONG_STOP_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
    SAFETY_SWEEP_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
    /** Servicio SOS (aislado): la API le pide abrir incidentes por llamada interna firmada. */
    SOS_INTERNAL_URL: z.string().url().default('http://localhost:3003'),
    REASSIGN_ARRIVED_COMPENSATION_CENTS: z.coerce.number().int().min(0).max(500).default(100),

    MATCHING_OFFER_TTL_SECONDS: z.coerce.number().int().min(5).max(60).default(15),
    MATCHING_RADIUS_M: z.coerce.number().int().min(500).max(20000).default(5000),
    MATCHING_MAX_RADIUS_M: z.coerce.number().int().min(500).max(30000).default(8000),
    /** Retención del manifiesto y datos de acompañantes/terceros (decisión aprobada: 180 días). */
    MANIFEST_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
    /** Página pública de seguimiento para terceros sin app. */
    TRACKING_BASE_URL: z.string().url().default('https://seguir.intitaxi.ec'),
    /** Portal del titular de datos (aviso LOPDP, consentimiento de acompañantes). */
    SUBJECT_PORTAL_URL: z.string().url().default('https://privacidad.intitaxi.ec'),
    /** Pasarela PCI DSS: "kushki" en producción; "mock" solo desarrollo. */
    PAYMENT_GATEWAY: z.enum(['kushki', 'mock']).default('mock'),
    KUSHKI_BASE_URL: z.string().url().default('https://api-uat.kushkipagos.com'),
    KUSHKI_PRIVATE_MERCHANT_ID: z.string().optional(),
    KUSHKI_WEBHOOK_SECRET: z.string().optional(),
    WEBHOOK_SECRET_PAYMENTS: base64Key(32).optional(),
    /** Comisión de la plataforma en puntos básicos (2000 = 20 %). ⚠️ Definir con el negocio. */
    PAYOUT_MIN_CENTS: z.coerce.number().int().min(100).default(500),
    /** Espera tras registrar/cambiar la cuenta bancaria antes de poder retirar (anti robo de cuenta). */
    PAYOUT_ACCOUNT_COOLDOWN_HOURS: z.coerce.number().int().min(0).max(240).default(72),
    /** ECU 911: "mock" (desarrollo/pruebas, nunca contacta al 911 real), "signed_link" (sin convenio), "agreement" (con convenio, mTLS). */
    ECU911_ADAPTER: z.enum(['mock', 'signed_link', 'agreement']).default('mock'),
    ECU911_ENDPOINT: z.string().url().optional(),
    ECU911_CLIENT_CERT_FILE: z.string().optional(),
    ECU911_CLIENT_KEY_FILE: z.string().optional(),
    ECU911_CA_FILE: z.string().optional(),
    /** Si ningún operador atiende el incidente en N segundos, se escala automáticamente (fail-safe). */
    ECU911_AUTO_ESCALATE_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
    /** Clave ES256 para firmar manifiestos (en producción: clave asimétrica de KMS). */
    MANIFEST_SIGNING_KEY_PEM: z.string().min(1),
    MANIFEST_SIGNING_KID: z.string().default('manifest-1'),
    SAFETY_PIN_PEPPER: base64Key(32),
    AUDIO_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    AUTHORITY_LINK_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    MATCHING_SWEEP_MS: z.coerce.number().int().min(200).max(10000).default(1000),
  })
  .superRefine((c, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    checkInfraConfig(c, add);
    if (!c.AUTH_JWKS_URL && !c.AUTH_JWKS_JSON) add('AUTH_JWKS_URL', 'requerida');
    if (c.KYC_PROVIDER === 'veriff' && (!c.VERIFF_API_KEY || !c.VERIFF_SHARED_SECRET)) add('VERIFF_API_KEY', 'requerida con KYC_PROVIDER=veriff');
    if (c.KYC_PROVIDER === 'mock' && !c.WEBHOOK_SECRET_KYC) add('WEBHOOK_SECRET_KYC', 'requerida con KYC_PROVIDER=mock');
    if (c.PAYMENT_GATEWAY === 'kushki' && (!c.KUSHKI_PRIVATE_MERCHANT_ID || !c.KUSHKI_WEBHOOK_SECRET)) add('KUSHKI_PRIVATE_MERCHANT_ID', 'requerida con PAYMENT_GATEWAY=kushki');
    if (c.PAYMENT_GATEWAY === 'mock' && !c.WEBHOOK_SECRET_PAYMENTS) add('WEBHOOK_SECRET_PAYMENTS', 'requerida con PAYMENT_GATEWAY=mock');
    if (c.ECU911_ADAPTER === 'agreement' && (!c.ECU911_ENDPOINT || !c.ECU911_CLIENT_CERT_FILE || !c.ECU911_CLIENT_KEY_FILE)) add('ECU911_ENDPOINT', 'requerida (con certificados mTLS) con ECU911_ADAPTER=agreement');
    if (c.MAPS_PROVIDER === 'google' && !c.GOOGLE_MAPS_API_KEY) add('GOOGLE_MAPS_API_KEY', 'requerida con MAPS_PROVIDER=google');
    if (c.STORAGE_DRIVER === 's3' && !c.S3_BUCKET) add('S3_BUCKET', 'requerida con STORAGE_DRIVER=s3');
    if (c.NODE_ENV !== 'production') return;
    const prod = (ok: boolean, path: string, message: string) => !ok && add(path, `producción: ${message}`);
    prod(!c.DEV_TOOLS, 'DEV_TOOLS', 'no se permiten herramientas de desarrollo');
    prod(c.KYC_PROVIDER === 'veriff', 'KYC_PROVIDER', 'no se permite el proveedor simulado');
    prod(!c.AUTH_JWKS_JSON, 'AUTH_JWKS_JSON', 'usa AUTH_JWKS_URL');
    prod(c.ECU911_ADAPTER !== 'mock', 'ECU911_ADAPTER', 'el adaptador simulado no se permite en producción');
    prod(c.PAYMENT_GATEWAY === 'kushki', 'PAYMENT_GATEWAY', 'no se permite la pasarela simulada');
    prod(c.MAPS_PROVIDER === 'google', 'MAPS_PROVIDER', 'debe ser google');
    prod(c.STORAGE_DRIVER === 's3' && !!c.S3_KMS_KEY_ID, 'STORAGE_DRIVER', 'debe ser s3 con SSE-KMS');
  });

export type AppConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => parseEnv(schema, env);
