import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { maskDocument, type BlindIndex, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, REDIS, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { BLIND_INDEX, CONFIG, FIELD_CIPHER, PG_POOL } from '../../tokens.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { FraudService } from './fraud.service.js';
import { liabilityBalance, postLedger } from './ledger.js';

/** Bancos admitidos (código interno). ⚠️ Completar con el catálogo de la red de pagos interbancarios. */
export const BANKS = ['PICHINCHA', 'GUAYAQUIL', 'PACIFICO', 'PRODUBANCO', 'BOLIVARIANO', 'INTERNACIONAL', 'AUSTRO', 'MACHALA', 'JEP', 'JARDIN_AZUAYO'];

@Injectable()
export class PayoutsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(FraudService) private readonly fraud: FraudService,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  #assertNotLocked(auth: AuthContext) {
    if (auth.sensitiveOpsLockedUntil && auth.sensitiveOpsLockedUntil * 1000 > Date.now()) {
      throw new AppError(403, 'sensitive_ops_locked', 'Por seguridad, esta operación está bloqueada temporalmente. Confirma con tu passkey para desbloquearla.');
    }
  }

  async earnings(driverId: string) {
    const balance = await liabilityBalance(this.pool, `driver_payable:${driverId}`);
    const { rows } = await this.pool.query(
      `SELECT t.id AS "tripId", t.ended_at AS "endedAt", t.final_fare_cents AS "fareCents", t.payment_method AS "paymentMethod"
       FROM trips.trips t WHERE t.driver_id = $1 AND t.status = 'completed' ORDER BY t.ended_at DESC LIMIT 50`,
      [driverId],
    );
    const payouts = await this.pool.query(`SELECT id, amount_cents AS "amountCents", status, requested_at AS "requestedAt" FROM payments.payouts WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT 20`, [driverId]);
    return { availableCents: balance, currency: 'USD', trips: rows, payouts: payouts.rows, note: balance < 0 ? 'Saldo negativo: comisiones de viajes cobrados en efectivo pendientes de compensar' : undefined };
  }

  /**
   * Cuenta bancaria del conductor. El titular debe ser el propio conductor (su cédula verificada por KYC):
   * así un atacante que robe la cuenta no puede desviar las ganancias a una cuenta suya.
   */
  async setAccount(auth: AuthContext, input: { bankCode: string; accountType: 'savings' | 'checking'; accountNumber: string; holderName: string; holderCedula: string }, req: AppRequest) {
    this.#assertNotLocked(auth);
    const kyc = await this.pool.query<{ doc_number_hmac: Buffer }>(`SELECT doc_number_hmac FROM kyc.verifications WHERE user_id = $1 AND kind = 'full' AND status = 'approved'`, [auth.userId]);
    if (!kyc.rows[0] || !this.bidx.compute('id_document', input.holderCedula.toUpperCase()).equals(kyc.rows[0].doc_number_hmac)) {
      await this.audit.record({ action: 'payout_account.set', resourceType: 'driver', resourceId: auth.userId, outcome: 'denied', metadata: { reason: 'holder_mismatch' } }, req);
      throw new AppError(422, 'holder_mismatch', 'La cuenta debe estar a nombre del conductor (misma cédula verificada)');
    }
    const id = randomUUID();
    await withTransaction(this.pool, async (c) => {
      await c.query('UPDATE payments.payout_accounts SET revoked_at = now() WHERE driver_id = $1 AND revoked_at IS NULL', [auth.userId]);
      await c.query(
        `INSERT INTO payments.payout_accounts (id, driver_id, bank_code, account_type, account_number_enc, account_number_masked, holder_name_enc, usable_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))`,
        [id, auth.userId, input.bankCode, input.accountType, await this.cipher.encrypt(input.accountNumber, `payments.payout_accounts.number:${id}`), maskDocument(input.accountNumber),
          await this.cipher.encrypt(input.holderName, `payments.payout_accounts.holder:${id}`), this.config.PAYOUT_ACCOUNT_COOLDOWN_HOURS],
      );
      await this.audit.record({ action: 'payout_account.set', resourceType: 'driver', resourceId: auth.userId, metadata: { bank: input.bankCode } }, req, c);
    });
    await this.notify.notifyUser(auth.userId, 'payout_account_changed', {
      sms: `Inti Taxi: se registró una nueva cuenta bancaria para tus retiros. Podrás retirar en ${this.config.PAYOUT_ACCOUNT_COOLDOWN_HOURS} h. Si no fuiste tú, contacta a soporte.`,
    });
    return { id, account: maskDocument(input.accountNumber), usableInHours: this.config.PAYOUT_ACCOUNT_COOLDOWN_HOURS };
  }

  async request(auth: AuthContext, amountCents: number, idempotencyKey: string, req: AppRequest) {
    this.#assertNotLocked(auth);
    const prior = await this.pool.query('SELECT id, status, amount_cents FROM payments.payouts WHERE idempotency_key = $1 AND driver_id = $2', [idempotencyKey, auth.userId]);
    if (prior.rows[0]) return { id: prior.rows[0].id, status: prior.rows[0].status, amountCents: prior.rows[0].amount_cents };
    if (amountCents < this.config.PAYOUT_MIN_CENTS) throw new AppError(400, 'amount_too_low', `El retiro mínimo es ${this.config.PAYOUT_MIN_CENTS / 100} USD`);
    const acc = await this.pool.query<{ id: string; ready: boolean }>(`SELECT id, usable_from <= now() AS ready FROM payments.payout_accounts WHERE driver_id = $1 AND revoked_at IS NULL`, [auth.userId]);
    if (!acc.rows[0]) throw new AppError(409, 'no_payout_account', 'Registra tu cuenta bancaria');
    if (!acc.rows[0].ready) throw new AppError(409, 'payout_account_cooldown', 'Tu cuenta bancaria es nueva: espera el periodo de seguridad');
    const day = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments.payouts WHERE driver_id = $1 AND requested_at > now() - interval '1 day'`, [auth.userId]);
    if (day.rows[0]!.n >= 2) throw new AppError(429, 'too_many_payouts', 'Máximo 2 retiros por día');
    const review = await this.fraud.blocksPayout(auth.userId);
    const id = randomUUID();
    // Candado por conductor: dos retiros simultáneos no pueden gastar el mismo saldo.
    const lock = await this.redis.set(`lock:payout:${auth.userId}`, id, 'EX', 30, 'NX');
    if (lock !== 'OK') throw new AppError(409, 'payout_in_progress', 'Ya hay un retiro en proceso');
    try {
      await withTransaction(this.pool, async (c) => {
        const available = await liabilityBalance(c, `driver_payable:${auth.userId}`);
        if (amountCents > available) throw new AppError(409, 'insufficient_balance', 'Saldo insuficiente');
        await c.query(
          `INSERT INTO payments.payouts (id, driver_id, payout_account_id, amount_cents, status, idempotency_key, review_reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, auth.userId, acc.rows[0]!.id, amountCents, review ? 'under_review' : 'requested', idempotencyKey, review ? 'señales de fraude abiertas' : null],
        );
        await postLedger(c, 'payout_request', { type: 'payout', id }, [{ account: `driver_payable:${auth.userId}`, debit: amountCents }, { account: 'payouts_pending', credit: amountCents }]);
        await this.audit.record({ action: 'payout.request', resourceType: 'payout', resourceId: id, metadata: { amountCents, review } }, req, c);
      });
    } finally {
      await this.redis.del(`lock:payout:${auth.userId}`);
    }
    return { id, status: review ? 'under_review' : 'requested', amountCents };
  }

  /** Finanzas / antifraude: marca pagado (transferencia hecha) o rechaza (devuelve el saldo). */
  async decide(adminId: string, payoutId: string, decision: 'paid' | 'rejected', reason: string, req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query(`SELECT * FROM payments.payouts WHERE id = $1 AND status IN ('requested', 'under_review', 'processing') FOR UPDATE`, [payoutId]);
      const p = rows[0];
      if (!p) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (p.driver_id === adminId) throw new AppError(403, 'forbidden', 'No puedes decidir tus propios retiros');
      await c.query('UPDATE payments.payouts SET status = $2, processed_at = now(), processed_by = $3, review_reason = coalesce(review_reason, $4) WHERE id = $1', [payoutId, decision, adminId, reason]);
      const postings = decision === 'paid'
        ? [{ account: 'payouts_pending', debit: p.amount_cents }, { account: 'bank_clearing', credit: p.amount_cents }]
        : [{ account: 'payouts_pending', debit: p.amount_cents }, { account: `driver_payable:${p.driver_id}`, credit: p.amount_cents }];
      await postLedger(c, `payout_${decision}`, { type: 'payout', id: payoutId }, postings);
      await this.audit.record({ action: `payout.${decision}`, resourceType: 'payout', resourceId: payoutId, actorUserId: adminId, actorRole: 'fraud_analyst', metadata: { reason } }, req, c);
    });
    return { payoutId, status: decision };
  }
}
