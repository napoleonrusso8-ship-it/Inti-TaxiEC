import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { InternalAuthGuard, parseInput } from '@intitaxi/nest-common';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { SosService } from './sos.service.js';

/**
 * Llamadas internas firmadas (HMAC) desde la API: una comprobación de seguridad sin respuesta o con
 * pedido de ayuda (alerta de desvío / parada larga) abre un incidente como si fuera un SOS.
 */
@Controller('internal/v1')
@UseGuards(InternalAuthGuard)
export class InternalSafetyController {
  constructor(
    @Inject(SosService) private readonly sos: SosService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Post('safety-escalations')
  @HttpCode(201)
  async escalate(@Body() body: unknown) {
    const i = parseInput(z.object({ tripId: z.string().uuid(), checkId: z.string().uuid(), reason: z.enum(['no_response', 'help_requested']) }), body);
    const last = (await this.pool.query(`SELECT lat::float8 AS lat, lng::float8 AS lng FROM trips.trip_locations WHERE trip_id = $1 ORDER BY at DESC LIMIT 1`, [i.tripId])).rows[0] ?? null;
    return this.sos.activate(i.tripId, { kind: 'system', reason: `safety_check:${i.reason}` }, 'sos', last);
  }
}
