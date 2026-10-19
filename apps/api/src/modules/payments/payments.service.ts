import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sha256, type BlindIndex, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { BLIND_INDEX, CONFIG, FIELD_CIPHER, PAYMENT_GATEWAY, PG_POOL } from '../../tokens.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PresenceService } from '../trips/presence.service.js';
import { TripEvents } from '../trips/trip-events.js';
import { TripsService, type TripRow } from '../trips/trips.service.js';
import { FraudService } from './fraud.service.js';
import type { GatewayEvent, PaymentGateway } from './gateway.js';
import { liabilityBalance, postLedger, split } from './ledger.js';

const refAad = (id: string) => `payments.payment_methods.gateway_ref:${id}`;

@Injectable()
export class PaymentsService implements OnModuleInit {
  readonly #log = new Logger('Payments');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(FraudService) private readonly fraud: FraudService,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // Validación del medio de pago al pedir el viaje (dentro de la transacción de creación).
    this.trips.hooks.push({
      beforeCreate: async (c, trip, input) => {
        await this.fraud.onDeviceUse(trip.deviceId, trip.requesterUserId);
        const method = input.paymentMethod as string;
        const debt = await c.query(`SELECT 1 FROM payments.payments WHERE payer_user_id = $1 AND status = 'declined'`, [trip.requesterUserId]);
        if (debt.rowCount) throw new AppError(409, 'payment_debt', 'Tienes un pago pendiente: págalo con otra tarjeta antes de pedir otro viaje');
        if (method === 'card') {
          const pm = await c.query(`SELECT 1 FROM payments.payment_methods WHERE id = $1 AND user_id = $2 AND status = 'active'`, [input.paymentMethodId ?? null, trip.requesterUserId]);
          if (!pm.rowCount) throw new AppError(400, 'invalid_payment_method', 'Elige una tarjeta registrada y verificada');
        }
        if (method === 'wallet') {
          const fare = await c.query<{ quoted_fare_cents: number }>('SELECT quoted_fare_cents FROM trips.trips WHERE id = $1', [trip.id]);
          if ((await liabilityBalance(c, `wallet:${trip.requesterUserId}`)) < fare.rows[0]!.quoted_fare_cents) {
            throw new AppError(409, 'insufficient_wallet', 'Saldo de billetera insuficiente');
          }
        }
      },
    });
    this.events.onStatus(async (e) => {
      if (e.to === 'completed') await this.chargeTrip(e.tripId);
    });
  }

  // ---------- Medios de pago ----------

  async addCard(userId: string, device: AttestedDevice, cardToken: string, req: AppRequest) {
    if (device.flags.includes('device_integrity_basic_only')) throw new AppError(403, 'payment_method_not_allowed', 'En este dispositivo solo está disponible el pago en efectivo');
    const rl = await this.limiter.hit(`card-add:${userId}`, 3, 86400);
    if (!rl.allowed) {
      await this.fraud.signal('user', userId, 'card_velocity', 50);
      throw tooManyRequests(rl.retryAfterSeconds);
    }
    const saved = await this.gateway.saveCard({ cardToken, userRef: userId }).catch(() => {
      throw new AppError(422, 'card_rejected', 'La pasarela rechazó la tarjeta');
    });
    const id = randomUUID();
    const fp = saved.fingerprint ? this.bidx.compute('card_fingerprint', saved.fingerprint) : null;
    await this.pool.query(
      `INSERT INTO payments.payment_methods (id, user_id, gateway, gateway_ref_enc, brand, last4, exp_month, exp_year, fingerprint_hmac, status, three_ds_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, userId, this.gateway.name, await this.cipher.encrypt(saved.gatewayRef, refAad(id)), saved.brand, saved.last4, saved.expMonth, saved.expYear, fp, saved.status, saved.threeDsRef ?? null],
    );
    await this.fraud.onCardSaved(userId, fp);
    await this.audit.record({ action: 'payment_method.add', resourceType: 'payment_method', resourceId: id, metadata: { status: saved.status, last4: saved.last4 } }, req);
    return { id, brand: saved.brand, last4: saved.last4, status: saved.status, threeDsUrl: saved.threeDsUrl };
  }

  async listCards(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, brand, last4, exp_month AS "expMonth", exp_year AS "expYear", status FROM payments.payment_methods WHERE user_id = $1 AND status <> 'revoked' ORDER BY created_at`,
      [userId],
    );
    return rows;
  }

  async removeCard(userId: string, id: string, req: AppRequest) {
    const r = await this.pool.query(`UPDATE payments.payment_methods SET status = 'revoked', revoked_at = now() WHERE id = $1 AND user_id = $2 AND status <> 'revoked'`, [id, userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'payment_method.remove', resourceType: 'payment_method', resourceId: id }, req);
  }

  // ---------- Cobro del viaje ----------

  async #cardRef(paymentMethodId: string) {
    const { rows } = await this.pool.query<{ id: string; gateway_ref_enc: Buffer; status: string }>('SELECT id, gateway_ref_enc, status FROM payments.payment_methods WHERE id = $1', [paymentMethodId]);
    if (!rows[0] || rows[0].status !== 'active') return null;
    return this.cipher.decrypt(rows[0].gateway_ref_enc, refAad(rows[0].id));
  }

  /** Idempotente por viaje: solo hay un cobro por viaje (clave única). */
  async chargeTrip(tripId: string) {
    const t = await this.trips.load(tripId);
    if (!t || t.status !== 'completed' || !t.driver_id || t.final_fare_cents === null) return;
    const exists = await this.pool.query('SELECT 1 FROM payments.payments WHERE idempotency_key = $1', [`trip:${tripId}:charge`]);
    if (exists.rowCount) return;
    const fare = t.final_fare_cents;
    const { commission, driver } = split(fare, this.config.PLATFORM_COMMISSION_BPS);
    const paymentId = randomUUID();
    let status: 'approved' | 'declined' | 'cash_collected' = 'cash_collected';
    let gatewayRef: string | undefined;
    let declineReason: string | undefined;
    if (t.payment_method === 'card') {
      const ref = t.payment_method_id ? await this.#cardRef(t.payment_method_id) : null;
      const r = ref ? await this.gateway.charge({ gatewayRef: ref, amountCents: fare, idempotencyKey: `trip:${tripId}:charge`, description: `Viaje Inti Taxi ${tripId.slice(0, 8)}` }) : { status: 'declined' as const, declineReason: 'no_card' };
      status = r.status;
      gatewayRef = r.gatewayRef;
      declineReason = r.declineReason;
    } else if (t.payment_method === 'wallet') {
      status = 'approved';
    }
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO payments.payments (id, trip_id, payer_user_id, method, payment_method_id, amount_cents, status, gateway_ref, decline_reason, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [paymentId, tripId, t.requester_user_id, t.payment_method, t.payment_method_id, fare, status, gatewayRef ?? null, declineReason ?? null, `trip:${tripId}:charge`],
      );
      const ref = { type: 'payment', id: paymentId };
      if (t.payment_method === 'cash') {
        // El conductor cobró en efectivo: la comisión se descuenta de lo que se le debe (puede quedar en negativo).
        await postLedger(c, 'trip_cash_commission', ref, [{ account: `driver_payable:${t.driver_id}`, debit: commission }, { account: 'platform_revenue', credit: commission }]);
      } else if (status === 'approved') {
        const source = t.payment_method === 'card' ? 'gateway_clearing' : `wallet:${t.requester_user_id}`;
        await postLedger(c, `trip_${t.payment_method}`, ref, [
          { account: source, debit: fare },
          { account: 'platform_revenue', credit: commission },
          { account: `driver_payable:${t.driver_id}`, credit: driver },
        ]);
      } else {
        // Cobro rechazado: el conductor cobra igual (lo asume la plataforma) y el pasajero queda con deuda.
        await postLedger(c, 'trip_card_declined', ref, [{ account: 'gateway_clearing', debit: fare }, { account: 'platform_revenue', credit: commission }, { account: `driver_payable:${t.driver_id}`, credit: driver }]);
      }
      await this.audit.record({ action: 'payment.trip', resourceType: 'payment', resourceId: paymentId, actorRole: 'system', outcome: status === 'declined' ? 'failure' : 'success', metadata: { method: t.payment_method, status } }, undefined, c);
    });
    if (status === 'declined') {
      await this.notify.notifyUser(t.requester_user_id, 'payment_declined', { sms: 'Inti Taxi: no pudimos cobrar tu último viaje con tu tarjeta. Actualiza tu medio de pago en la app.' });
    }
    await this.fraud.onTripCompleted(t as TripRow & { driver_id: string }, await this.presence.gpsFlags(t.driver_id));
  }

  /** Reintento de un cobro rechazado con otra tarjeta (salda la deuda). */
  async retry(userId: string, paymentId: string, paymentMethodId: string, req: AppRequest) {
    const { rows } = await this.pool.query<{ id: string; amount_cents: number; trip_id: string }>(`SELECT * FROM payments.payments WHERE id = $1 AND payer_user_id = $2 AND status = 'declined'`, [paymentId, userId]);
    const p = rows[0];
    if (!p) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const own = await this.pool.query(`SELECT 1 FROM payments.payment_methods WHERE id = $1 AND user_id = $2 AND status = 'active'`, [paymentMethodId, userId]);
    const ref = own.rowCount ? await this.#cardRef(paymentMethodId) : null;
    if (!ref) throw new AppError(400, 'invalid_payment_method', 'Tarjeta no válida');
    const r = await this.gateway.charge({ gatewayRef: ref, amountCents: p.amount_cents, idempotencyKey: `payment:${paymentId}:retry:${paymentMethodId}`, description: `Viaje Inti Taxi ${p.trip_id.slice(0, 8)}` });
    if (r.status !== 'approved') throw new AppError(402, 'payment_declined', 'La tarjeta fue rechazada');
    await this.pool.query(`UPDATE payments.payments SET status = 'approved', gateway_ref = $2, payment_method_id = $3, decline_reason = NULL, updated_at = now() WHERE id = $1`, [paymentId, r.gatewayRef, paymentMethodId]);
    await this.audit.record({ action: 'payment.retry', resourceType: 'payment', resourceId: paymentId }, req);
    return { paymentId, status: 'approved' };
  }

  /** Recibo para quien pagó, con hora de Guayaquil. */
  async receipt(userId: string, tripId: string) {
    const t = await this.trips.load(tripId);
    if (!t || t.requester_user_id !== userId) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const { rows } = await this.pool.query(`SELECT p.*, m.brand, m.last4 FROM payments.payments p LEFT JOIN payments.payment_methods m ON m.id = p.payment_method_id WHERE p.trip_id = $1`, [tripId]);
    const p = rows[0];
    if (!p) throw new AppError(409, 'not_charged', 'El viaje aún no tiene cobro');
    const card = t.driver_id ? await this.trips.driverCard(t.driver_id, t.vehicle_id) : null;
    const fmt = (d: Date | null) => (d ? new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'medium', timeStyle: 'short' }).format(d) : null);
    return {
      receiptId: p.id,
      trip: { id: t.id, type: t.type, start: fmt(t.started_at), end: fmt(t.ended_at), distanceKm: Math.round(t.distance_m / 100) / 10, partySize: t.party_size },
      driver: card ? { firstName: card.firstName, plate: card.vehicle?.plate } : null,
      amount: { totalCents: p.amount_cents, currency: p.currency, refundedCents: p.refunded_cents },
      payment: { method: p.method, card: p.last4 ? `${p.brand} •••• ${p.last4}` : null, status: p.status },
      timezone: 'America/Guayaquil',
    };
  }

  // ---------- Billetera (sin recargas: solo reembolsos y créditos promocionales) ----------

  async wallet(userId: string) {
    const balance = await liabilityBalance(this.pool, `wallet:${userId}`);
    const { rows } = await this.pool.query(
      `SELECT kind, credit_cents - debit_cents AS "amountCents", created_at AS at FROM payments.ledger_entries WHERE account = $1 ORDER BY id DESC LIMIT 50`,
      [`wallet:${userId}`],
    );
    return { balanceCents: balance, currency: 'USD', topUpsEnabled: false, movements: rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) })) };
  }

  async creditWallet(adminId: string, userId: string, amountCents: number, reason: string, req: AppRequest) {
    await withTransaction(this.pool, async (c) => {
      await postLedger(c, 'promo_credit', { type: 'user', id: userId }, [{ account: 'promo_expense', debit: amountCents }, { account: `wallet:${userId}`, credit: amountCents }]);
      await this.audit.record({ action: 'wallet.credit', resourceType: 'user', resourceId: userId, actorUserId: adminId, actorRole: 'support', metadata: { amountCents, reason } }, req, c);
    });
    return { userId, balanceCents: await liabilityBalance(this.pool, `wallet:${userId}`) };
  }

  /**
   * Reembolso (soporte): a la tarjeta vía pasarela o como crédito en la billetera.
   * El monto se reserva atómicamente antes de llamar a la pasarela: dos reembolsos simultáneos no pueden superar lo cobrado.
   */
  async refund(adminId: string, paymentId: string, amountCents: number, to: 'original' | 'wallet', reason: string, req: AppRequest) {
    const reserved = await this.pool.query<{ method: string; gateway_ref: string; payer_user_id: string; amount_cents: number; refunded_cents: number }>(
      `UPDATE payments.payments SET refunded_cents = refunded_cents + $2, updated_at = now()
       WHERE id = $1 AND status IN ('approved', 'cash_collected', 'partially_refunded') AND refunded_cents + $2 <= amount_cents
         AND ($3 = 'wallet' OR method = 'card')
       RETURNING method, gateway_ref, payer_user_id, amount_cents, refunded_cents`,
      [paymentId, amountCents, to],
    );
    const p = reserved.rows[0];
    if (!p) throw new AppError(409, 'not_refundable', 'Pago no reembolsable por ese monto o a ese destino');
    if (to === 'original') {
      const r = await this.gateway.refund({ chargeRef: p.gateway_ref, amountCents, idempotencyKey: `refund:${paymentId}:${p.refunded_cents}` }).catch(() => ({ status: 'failed' as const }));
      if (r.status !== 'refunded') {
        await this.pool.query('UPDATE payments.payments SET refunded_cents = refunded_cents - $2 WHERE id = $1', [paymentId, amountCents]);
        throw new AppError(502, 'refund_failed', 'La pasarela no procesó el reembolso');
      }
    }
    await withTransaction(this.pool, async (c) => {
      const credit = to === 'original' ? 'gateway_clearing' : `wallet:${p.payer_user_id}`;
      await postLedger(c, `refund_${to}`, { type: 'payment', id: paymentId }, [{ account: 'refunds_issued', debit: amountCents }, { account: credit, credit: amountCents }]);
      await c.query(`UPDATE payments.payments SET status = $2 WHERE id = $1`, [paymentId, p.refunded_cents >= p.amount_cents ? 'refunded' : 'partially_refunded']);
      await this.audit.record({ action: 'payment.refund', resourceType: 'payment', resourceId: paymentId, actorUserId: adminId, actorRole: 'support', metadata: { amountCents, to, reason } }, req, c);
    });
    return { paymentId, refundedCents: amountCents, to };
  }

  // ---------- Webhooks y 3-D Secure ----------

  async handleWebhook(rawBody: Buffer | undefined, headers: Record<string, string | undefined>, req: AppRequest) {
    const ev = rawBody ? this.gateway.verifyWebhook(rawBody, headers) : null;
    if (!ev) {
      await this.audit.recordSafe({ action: 'payments.webhook', resourceType: 'payment_webhook', outcome: 'denied', actorRole: 'gateway' }, req);
      throw new AppError(401, 'invalid_signature', 'Firma inválida');
    }
    const fresh = await this.pool.query('INSERT INTO payments.webhook_events (event_hash, gateway) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sha256(rawBody!), this.gateway.name]);
    if (!fresh.rowCount) return { result: 'duplicate' };
    await this.#apply(ev);
    return { result: 'ok' };
  }

  async #apply(ev: GatewayEvent) {
    if (ev.type === 'three_ds_completed') {
      await this.pool.query(`UPDATE payments.payment_methods SET status = $2 WHERE three_ds_ref = $1 AND status = 'pending_3ds'`, [ev.ref, ev.status === 'authenticated' ? 'active' : 'revoked']);
    }
  }

  /** Para el resumen de un conductor o el control de deuda. */
  async balanceOf(account: string, c?: PoolClient) {
    return liabilityBalance(c ?? this.pool, account);
  }
}
