import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { AppError, AuditService, InternalAuthGuard, parseInput, REDIS } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';

/**
 * Proveedor de números enmascarados (llamadas entre pasajero y conductor sin exponer números reales).
 * Pendiente elegir proveedor real (Infobip Number Masking o Twilio): requiere números ecuatorianos.
 */
export interface MaskedCallProvider {
  createSession(input: { sessionKey: string; phones: [string, string]; ttlSeconds: number }): Promise<{ proxyNumber: string }>;
  closeSession(sessionKey: string): Promise<void>;
}

/** Simulado: asigna un número "proxy" ficticio y guarda el mapeo en Redis (para el simulador). */
export class MockMaskedCallProvider implements MaskedCallProvider {
  constructor(private readonly redis: Redis) {}
  async createSession({ sessionKey, ttlSeconds }: { sessionKey: string; phones: [string, string]; ttlSeconds: number }) {
    const existing = await this.redis.get(`proxy:${sessionKey}`);
    const proxyNumber = existing ?? `+5934${String(randomInt(1_000_000, 9_999_999))}`;
    await this.redis.set(`proxy:${sessionKey}`, proxyNumber, 'EX', ttlSeconds);
    return { proxyNumber };
  }
  async closeSession(sessionKey: string) {
    await this.redis.del(`proxy:${sessionKey}`);
  }
}

export const MASKED_CALLS = Symbol('MASKED_CALLS');

/** Solo accesible para servicios internos firmados (la API nunca ve los números reales). */
@Controller('internal/v1/contact-sessions')
@UseGuards(InternalAuthGuard)
export class InternalContactController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(MASKED_CALLS) private readonly provider: MaskedCallProvider,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseInput(z.object({ sessionKey: z.string().uuid(), participants: z.tuple([z.string().uuid(), z.string().uuid()]), ttlSeconds: z.number().int().min(60).max(7200) }), body);
    const [a, b] = await Promise.all(input.participants.map((id) => this.users.findById(id)));
    if (!a || !b) throw new AppError(404, 'not_found');
    const phones: [string, string] = [await this.users.phoneOf(a), await this.users.phoneOf(b)];
    const r = await this.provider.createSession({ sessionKey: input.sessionKey, phones, ttlSeconds: input.ttlSeconds });
    await this.audit.record({ action: 'contact.masked_session', resourceType: 'trip', resourceId: input.sessionKey, actorRole: 'service' });
    return { proxyNumber: r.proxyNumber, expiresIn: input.ttlSeconds };
  }

  @Post('close')
  @HttpCode(204)
  async close(@Body() body: unknown) {
    const { sessionKey } = parseInput(z.object({ sessionKey: z.string().uuid() }), body);
    await this.provider.closeSession(sessionKey);
  }
}
