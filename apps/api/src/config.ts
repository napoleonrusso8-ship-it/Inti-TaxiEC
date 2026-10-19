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
  })
  .superRefine((c, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    checkInfraConfig(c, add);
    if (!c.AUTH_JWKS_URL && !c.AUTH_JWKS_JSON) add('AUTH_JWKS_URL', 'requerida');
    if (c.KYC_PROVIDER === 'veriff' && (!c.VERIFF_API_KEY || !c.VERIFF_SHARED_SECRET)) add('VERIFF_API_KEY', 'requerida con KYC_PROVIDER=veriff');
    if (c.KYC_PROVIDER === 'mock' && !c.WEBHOOK_SECRET_KYC) add('WEBHOOK_SECRET_KYC', 'requerida con KYC_PROVIDER=mock');
    if (c.NODE_ENV !== 'production') return;
    const prod = (ok: boolean, path: string, message: string) => !ok && add(path, `producción: ${message}`);
    prod(!c.DEV_TOOLS, 'DEV_TOOLS', 'no se permiten herramientas de desarrollo');
    prod(c.KYC_PROVIDER === 'veriff', 'KYC_PROVIDER', 'no se permite el proveedor simulado');
    prod(!c.AUTH_JWKS_JSON, 'AUTH_JWKS_JSON', 'usa AUTH_JWKS_URL');
  });

export type AppConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => parseEnv(schema, env);
