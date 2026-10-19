import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

/** Endurecimiento HTTP común: proxies de confianza, cabeceras, request id, límites de cuerpo. */
export function configureHttpApp(app: INestApplication, opts: { trustProxyHops: number; jsonLimit?: string; rawBodyPaths?: string[]; corsOrigins?: string[] }) {
  const ex = app as NestExpressApplication;
  // IP real solo a través del número exacto de proxies de confianza (ALB): evita falsificar X-Forwarded-For.
  ex.set('trust proxy', opts.trustProxyHops);
  ex.disable('x-powered-by');
  ex.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  ex.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (opts.corsOrigins?.length) ex.use(cors(opts.corsOrigins));
  // Los webhooks necesitan el cuerpo exacto para verificar la firma HMAC.
  ex.useBodyParser('json', {
    limit: opts.jsonLimit ?? '32kb',
    strict: true,
    verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
      if (opts.rawBodyPaths?.some((p) => req.url.startsWith(p))) req.rawBody = Buffer.from(buf);
    },
  });
  ex.useBodyParser('urlencoded', { limit: '8kb', extended: false });
  app.enableShutdownHooks();
}

/**
 * CORS mínimo y explícito para el panel web: lista blanca exacta de orígenes, sin cookies
 * (los tokens van en cabeceras DPoP, nunca en cookies, así que no hay CSRF), preflight en caché 10 min.
 * Un origen no listado no recibe cabeceras CORS y el navegador bloquea la respuesta.
 */
export function cors(origins: string[]) {
  const allowed = new Set(origins);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    res.vary('Origin');
    if (!origin || !allowed.has(origin)) return next();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
    if (req.method === 'OPTIONS' && req.header('access-control-request-method')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, DPoP, Content-Type, Idempotency-Key, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
