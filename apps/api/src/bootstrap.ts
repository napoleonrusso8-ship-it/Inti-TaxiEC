import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { configureHttpApp } from '@intitaxi/nest-common';
import { AppModule, type ServiceRole } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(config: AppConfig, role: ServiceRole = 'api'): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forConfig(config, role), {
    bodyParser: false,
    abortOnError: false,
    logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  configureHttpApp(app, { trustProxyHops: config.TRUST_PROXY_HOPS, rawBodyPaths: ['/v1/webhooks/'] });
  return app;
}
