import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@intitaxi/nest-common';
import { AppModule, type ServiceRole } from './app.module.js';
import { devStorageUpload } from './modules/drivers/dev-storage-upload.js';
import { STORAGE } from './tokens.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig, role: ServiceRole = 'api'): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forConfig(config, role), {
    bodyParser: false,
    abortOnError: false,
    logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  if (config.DEV_TOOLS && role === 'api') app.use(devStorageUpload(app.get(STORAGE, { strict: false })));
  configureHttpApp(app, { trustProxyHops: config.TRUST_PROXY_HOPS, corsOrigins: config.CORS_ORIGINS, rawBodyPaths: ['/v1/webhooks/'] });
  // Audio del SOS: cuerpo binario de hasta 256 KB (solo en el servicio sos).
  if (role === 'sos') (app as unknown as { useBodyParser(t: string, o: object): void }).useBodyParser('raw', { type: ['audio/aac', 'audio/mp4', 'audio/webm', 'audio/ogg'], limit: '256kb' });
  return app;
}
