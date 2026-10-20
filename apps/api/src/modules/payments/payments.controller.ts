import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, Device, parseInput, RecentMfaGuard, RequirePhishingResistant, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, PAYMENT_GATEWAY, PG_POOL } from '../../tokens.js';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { MockGateway, type PaymentGateway } from './gateway.js';
import { CommissionService } from './commission.service.js';
import { PaymentsService } from './payments.service.js';
import { BANKS, PayoutsService } from './payouts.service.js';

const idem = (req: AppRequest) => {
  const k = req.header('idempotency-key');
  if (!k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) throw new AppError(400, 'idempotency_key_required', 'Falta la cabecera Idempotency-Key');
  return k;
};

@Controller('v1')
@UseGuards(AccessTokenGuard)
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(PayoutsService) private readonly payouts: PayoutsService,
  ) {}

  /** El token lo genera el SDK/campos alojados de la pasarela: el número de tarjeta nunca llega a Inti Taxi. */
  @Post('payment-methods')
  @HttpCode(201)
  @UseGuards(AttestationGuard)
  add(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Body() body: unknown) {
    const { cardToken } = parseInput(z.object({ cardToken: z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/) }), body);
    return this.payments.addCard(auth.userId, device, cardToken, req);
  }

  @Get('payment-methods')
  list(@Auth() auth: AuthContext) {
    return this.payments.listCards(auth.userId);
  }

  @Delete('payment-methods/:id')
  @HttpCode(204)
  remove(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.removeCard(auth.userId, id, req);
  }

  @Post('payments/:id/retry')
  @HttpCode(200)
  @UseGuards(AttestationGuard)
  retry(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { paymentMethodId } = parseInput(z.object({ paymentMethodId: z.string().uuid() }), body);
    return this.payments.retry(auth.userId, id, paymentMethodId, req);
  }

  @Get('trips/:id/receipt')
  receipt(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.receipt(auth.userId, id);
  }

  @Get('wallet')
  wallet(@Auth() auth: AuthContext) {
    return this.payments.wallet(auth.userId);
  }

  // ---------- Conductor ----------

  @Get('driver/earnings')
  earnings(@Auth() auth: AuthContext) {
    return this.payouts.earnings(auth.userId);
  }

  /** Cambiar la cuenta bancaria: passkey reciente (resistente al phishing), atestación y sin bloqueo anti SIM swap. */
  @Post('driver/payout-accounts')
  @HttpCode(201)
  @UseGuards(AttestationGuard, RecentMfaGuard)
  @RequirePhishingResistant()
  account(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    if (auth.clientId !== 'intitaxi-driver') throw new AppError(403, 'forbidden', 'Usa la app de conductor');
    const i = parseInput(
      z.object({
        bankCode: z.enum(BANKS as [string, ...string[]]),
        accountType: z.enum(['savings', 'checking']),
        accountNumber: z.string().regex(/^\d{6,20}$/),
        holderName: z.string().min(3).max(80).regex(/^[\p{L} '-]+$/u),
        holderCedula: z.string().regex(/^\d{10}$/),
      }),
      body,
    );
    return this.payouts.setAccount(auth, i, req);
  }

  @Post('driver/payouts')
  @HttpCode(201)
  @UseGuards(AttestationGuard, RecentMfaGuard)
  @RequirePhishingResistant()
  payout(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    if (auth.clientId !== 'intitaxi-driver') throw new AppError(403, 'forbidden', 'Usa la app de conductor');
    const { amountCents } = parseInput(z.object({ amountCents: z.number().int().positive().max(1_000_000) }), body);
    return this.payouts.request(auth, amountCents, idem(req), req);
  }
}

@Controller('v1/admin')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminPaymentsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(PayoutsService) private readonly payouts: PayoutsService,
    @Inject(CommissionService) private readonly commissions: CommissionService,
  ) {}

  @Post('payments/:id/refund')
  @HttpCode(200)
  @AdminRoles('support')
  @AdminWrite()
  refund(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ amountCents: z.number().int().positive(), to: z.enum(['original', 'wallet']), reason: z.string().min(5).max(300) }), body);
    return this.payments.refund(auth.userId, id, i.amountCents, i.to, i.reason, req);
  }

  @Post('wallets/:userId/credit')
  @HttpCode(200)
  @AdminRoles('support')
  @AdminWrite()
  credit(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    const i = parseInput(z.object({ amountCents: z.number().int().positive().max(5000), reason: z.string().min(5).max(300) }), body);
    if (userId === auth.userId) throw new AppError(403, 'forbidden', 'No puedes acreditarte a ti mismo');
    return this.payments.creditWallet(auth.userId, userId, i.amountCents, i.reason, req);
  }

  @Get('commissions')
  @AdminRoles('super_admin', 'fraud_analyst')
  commissionSettings() {
    return this.commissions.settings();
  }

  /** Solo super_admin: cambia las comisiones (queda auditado con los valores nuevos). */
  @Put('commissions')
  @AdminRoles('super_admin')
  @AdminWrite()
  updateCommissions(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(
      z.object({ on_demand_bps: z.number().int().min(0).optional(), route_fee_taxi_cents: z.number().int().min(0).optional(), route_fee_van_cents: z.number().int().min(0).optional(), assist_bps: z.number().int().min(0).optional() }).strict(),
      body,
    );
    return this.commissions.update(auth.userId, i, req);
  }

  @Get('fraud/signals')
  @AdminRoles('fraud_analyst')
  async signals(@Query('status') status = 'open') {
    const { rows } = await this.pool.query(`SELECT * FROM payments.fraud_signals WHERE status = $1 ORDER BY score DESC, created_at DESC LIMIT 100`, [parseInput(z.enum(['open', 'dismissed', 'confirmed']), status)]);
    return rows;
  }

  @Post('fraud/signals/:id')
  @HttpCode(200)
  @AdminRoles('fraud_analyst')
  @AdminWrite()
  async review(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { decision } = parseInput(z.object({ decision: z.enum(['dismissed', 'confirmed']) }), body);
    const r = await this.pool.query(`UPDATE payments.fraud_signals SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 AND status = 'open'`, [id, decision, auth.userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return { id, status: decision };
  }

  @Get('payouts')
  @AdminRoles('fraud_analyst')
  async payoutList(@Query('status') status = 'requested') {
    const { rows } = await this.pool.query(`SELECT id, driver_id AS "driverId", amount_cents AS "amountCents", status, review_reason AS "reviewReason", requested_at AS "requestedAt" FROM payments.payouts WHERE status = $1 ORDER BY requested_at LIMIT 200`, [parseInput(z.enum(['requested', 'under_review', 'processing', 'paid', 'rejected']), status)]);
    return rows;
  }

  @Post('payouts/:id/decision')
  @HttpCode(200)
  @AdminRoles('fraud_analyst')
  @AdminWrite()
  decide(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { decision, reason } = parseInput(z.object({ decision: z.enum(['paid', 'rejected']), reason: z.string().min(3).max(300) }), body);
    return this.payouts.decide(auth.userId, id, decision, reason, req);
  }
}

@Controller('v1/webhooks/payments')
export class PaymentsWebhookController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post(':gateway')
  @HttpCode(200)
  webhook(@Req() req: AppRequest) {
    const headers = Object.fromEntries(['x-signature', 'x-kushki-signature'].map((h) => [h, req.header(h)]));
    return this.payments.handleWebhook(req.rawBody, headers, req);
  }
}

/** SOLO DESARROLLO: simula el desafío 3-D Secure del banco emisor y envía el webhook firmado. */
@Controller('v1/dev/payments')
export class DevPaymentsController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('3ds/:ref/complete')
  @HttpCode(200)
  async complete(@Param('ref') ref: string, @Body() body: unknown) {
    if (!(this.gateway instanceof MockGateway)) throw new AppError(404, 'not_found');
    const { result } = parseInput(z.object({ result: z.enum(['authenticated', 'failed']).default('authenticated') }), body ?? {});
    const raw = JSON.stringify({ type: 'three_ds_completed', ref, status: result });
    const r = await fetch(`${this.config.PUBLIC_BASE_URL}/v1/webhooks/payments/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': this.gateway.sign(raw) }, body: raw });
    return { webhookStatus: r.status };
  }
}
