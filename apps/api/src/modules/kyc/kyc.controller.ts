import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { withTransaction, type Pool } from '@intitaxi/db';
import {
  AccessTokenGuard,
  AppError,
  AttestationGuard,
  Auth,
  AuditService,
  BLIND_INDEX,
  Device,
  parseInput,
  type AppRequest,
  type AttestedDevice,
} from '@intitaxi/nest-common';
import type { BlindIndex } from '@intitaxi/crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { KycService } from './kyc.service.js';

const Purpose = z.enum(['biometric_kyc', 'audio_recording', 'trip_sharing', 'companion_data']);

@Controller('v1')
export class ConsentsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Texto vigente (versión + hash). Público para poder mostrarlo antes del registro. */
  @Get('consents/texts/:purpose')
  async text(@Param('purpose') purpose: string) {
    const p = parseInput(Purpose, purpose);
    const { rows } = await this.pool.query('SELECT purpose, version, title, body, sha256 FROM kyc.consent_texts WHERE purpose = $1 ORDER BY version DESC LIMIT 1', [p]);
    if (!rows[0]) throw new AppError(404, 'not_found');
    return rows[0];
  }

  @Get('consents')
  @UseGuards(AccessTokenGuard)
  async mine(@Auth() auth: AuthContext) {
    const { rows } = await this.pool.query('SELECT purpose, action, text_version, created_at FROM kyc.current_consents WHERE user_id = $1', [auth.userId]);
    return rows.map((r) => ({ purpose: r.purpose, granted: r.action === 'grant', textVersion: r.text_version, at: r.created_at }));
  }

  /** El cliente debe enviar la versión y el hash del texto que mostró: no se puede consentir un texto distinto del vigente. */
  @Post('consents')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  async grant(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Body() body: unknown) {
    const input = parseInput(z.object({ purpose: Purpose, textVersion: z.number().int(), textSha256: z.string().regex(/^[0-9a-f]{64}$/) }), body);
    const { rows } = await this.pool.query('SELECT version, sha256 FROM kyc.consent_texts WHERE purpose = $1 ORDER BY version DESC LIMIT 1', [input.purpose]);
    if (!rows[0] || rows[0].version !== input.textVersion || rows[0].sha256 !== input.textSha256) {
      throw new AppError(409, 'consent_text_outdated', 'El texto del consentimiento cambió; vuelve a leerlo');
    }
    await this.pool.query(
      `INSERT INTO kyc.consents (id, user_id, purpose, action, text_version, text_sha256, device_id, ip_hmac) VALUES ($1, $2, $3, 'grant', $4, $5, $6, $7)`,
      [randomUUID(), auth.userId, input.purpose, input.textVersion, input.textSha256, device.deviceId, req.ip ? this.bidx.compute('ip', req.ip) : null],
    );
    await this.audit.record({ action: 'consent.grant', resourceType: 'consent', resourceId: input.purpose, metadata: { version: input.textVersion } }, req);
    return { purpose: input.purpose, granted: true };
  }

  /** Revocar es tan fácil como otorgar (LOPDP). */
  @Delete('consents/:purpose')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async revoke(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('purpose') purpose: string) {
    const p = parseInput(Purpose, purpose);
    await withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO kyc.consents (id, user_id, purpose, action) VALUES ($1, $2, $3, 'revoke')`, [randomUUID(), auth.userId, p]);
      if (p === 'biometric_kyc') await this.kyc.onBiometricConsentRevoked(auth.userId, c);
      await this.audit.record({ action: 'consent.revoke', resourceType: 'consent', resourceId: p }, req, c);
    });
  }
}

@Controller('v1/kyc')
export class KycController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  @Post('sessions')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  create(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Body() body: unknown) {
    const { kind } = parseInput(z.object({ kind: z.enum(['full', 'driver_reverify']).default('full') }), body ?? {});
    return this.kyc.createSession(auth.userId, kind, device.deviceId, req);
  }

  @Get('status')
  @UseGuards(AccessTokenGuard)
  status(@Auth() auth: AuthContext) {
    return this.kyc.status(auth.userId);
  }

  /** El conductor lo llama antes de conectarse. */
  @Post('reverification/check')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  check(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice) {
    return this.kyc.checkReverification(auth.userId, device.deviceId, device.flags.filter((f) => f.startsWith('risk:')), req);
  }
}

@Controller('v1/webhooks/kyc')
export class KycWebhookController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  @Post(':provider')
  @HttpCode(200)
  async webhook(@Req() req: AppRequest) {
    const headers = Object.fromEntries(['x-hmac-signature', 'x-auth-client'].map((h) => [h, req.header(h)]));
    return { result: await this.kyc.handleWebhook(req.rawBody, headers, req) };
  }
}
