import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import type { Redis } from 'ioredis';
import { PG_POOL, REDIS } from './tokens.js';

/** Solo debe exponerse a la red interna / ALB. */
@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready() {
    await Promise.all([this.pool.query('SELECT 1'), this.redis.ping()]);
    return { status: 'ready' };
  }
}
