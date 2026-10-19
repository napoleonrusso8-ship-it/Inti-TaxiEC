import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3004),
  /** URL pública canónica (https). La prueba DPoP del WebSocket se firma para `${PUBLIC_BASE_URL}/v1/ws`. */
  PUBLIC_BASE_URL: z.string().url(),
  REDIS_URL: z.string().min(1),
  REDIS_TLS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AUTH_ISSUER: z.string().url(),
  AUTH_JWKS_URL: z.string().url(),
  API_AUDIENCE: z.string().default('intitaxi-api'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  /** Teselas del mapa de la página de seguimiento (en producción: proveedor con contrato, p. ej. Google/Mapbox). */
  MAP_TILES_URL: z.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAX_CONNECTIONS_PER_USER: z.coerce.number().int().default(5),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error(`Configuración inválida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const c = r.data;
  if (c.NODE_ENV === 'production' && (!c.PUBLIC_BASE_URL.startsWith('https://') || !c.REDIS_TLS)) {
    throw new Error('Configuración inválida: producción exige https y TLS a Redis');
  }
  return c;
}
