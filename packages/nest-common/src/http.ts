import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

/** Endurecimiento HTTP común: proxies de confianza, cabeceras, request id, límites de cuerpo. */
export function configureHttpApp(app: INestApplication, opts: { trustProxyHops: number; jsonLimit?: string; rawBodyPaths?: string[] }) {
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
