import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { randomToken } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service.js';
import { AppError, parseInput, tooManyRequests } from '../../common/errors.js';
import { ATTESTATION_TICKET_TTL, attestationTicketKey, DpopProofGuard } from '../../common/guards.js';
import type { AppRequest, AttestedDevice } from '../../common/request.js';
import { OneTimeStore, RateLimiter } from '../../infra/redis-stores.js';
import { ATTESTATION_VERIFIERS, PG_POOL, REDIS } from '../../tokens.js';
import type { AttestationVerifier } from './verifiers.js';

const VerifyBody = z.object({
  platform: z.enum(['android', 'ios']),
  appId: z.string().regex(/^[a-z0-9_.]{3,100}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  token: z.string().min(8).max(16_384),
});

@Controller('v1/attestation')
@UseGuards(DpopProofGuard)
export class AttestationController {
  constructor(
    @Inject(ATTESTATION_VERIFIERS) private readonly verifiers: Record<'android' | 'ios', AttestationVerifier>,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Nonce de un solo uso ligado a la clave DPoP del dispositivo. */
  @Post('nonce')
  @HttpCode(200)
  async nonce(@Req() req: AppRequest) {
    const rl = await this.limiter.hit(`att-nonce:${req.dpop!.jkt}`, 10, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const nonce = randomToken(32);
    await this.once.put(`att:nonce:${nonce}`, { jkt: req.dpop!.jkt }, 120);
    return { nonce, expiresIn: 120 };
  }

  /** Verifica el token de Play Integrity / App Attest y emite un ticket de atestación de corta duración. */
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parseInput(VerifyBody, body);
    const jkt = req.dpop!.jkt;
    const stored = await this.once.take<{ jkt: string }>(`att:nonce:${input.nonce}`);
    if (!stored || stored.jkt !== jkt) throw new AppError(400, 'invalid_nonce', 'Nonce inválido o expirado');

    const result = await this.verifiers[input.platform].verify({ appId: input.appId, token: input.token, nonce: input.nonce });
    const status = result.passed ? 'passed' : 'failed';
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO identity.devices (id, platform, dpop_jkt, attestation_status, attestation_flags, attested_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (dpop_jkt) DO UPDATE
         SET attestation_status = EXCLUDED.attestation_status, attestation_flags = EXCLUDED.attestation_flags,
             attested_at = now(), last_seen_at = now()
         WHERE identity.devices.revoked_at IS NULL
       RETURNING id`,
      [randomUUID(), input.platform, jkt, status, result.flags],
    );
    // Un dispositivo revocado (p. ej. tras un fraude) no puede volver a atestarse con la misma clave.
    if (rows.length === 0) throw new AppError(403, 'attestation_failed', 'No pudimos verificar la integridad de la app o del dispositivo');
    const deviceId = rows[0]!.id;

    if (!result.passed) {
      await this.audit.record(
        { action: 'attestation.verify', resourceType: 'device', resourceId: deviceId, outcome: 'denied', actorDeviceId: deviceId, metadata: { flags: result.flags.join(',') } },
        req,
      );
      throw new AppError(403, 'attestation_failed', 'No pudimos verificar la integridad de la app o del dispositivo');
    }

    const ticket = randomToken(32);
    const device: AttestedDevice = { deviceId, platform: input.platform, jkt };
    await this.redis.set(attestationTicketKey(ticket), JSON.stringify(device), 'EX', ATTESTATION_TICKET_TTL);
    return { ticket, deviceId, expiresIn: ATTESTATION_TICKET_TTL };
  }
}
