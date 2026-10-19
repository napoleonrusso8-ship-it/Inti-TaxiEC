import { Inject, Injectable } from '@nestjs/common';
import type { FieldCipher } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { FIELD_CIPHER, PG_POOL } from '../../tokens.js';
import { PaymentsService } from '../payments/payments.service.js';
import { TripsService } from '../trips/trips.service.js';

const aad = (id: string) => `support.disputes.description:${id}`;
const WINDOW_DAYS = 30;

/**
 * Disputas de viajes: las abre el solicitante o el conductor de un viaje terminado; las resuelve soporte.
 * La descripción va cifrada; el listado del panel no la incluye y abrir el detalle exige motivo y queda auditado.
 */
@Injectable()
export class DisputesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async open(userId: string, tripId: string, input: { category: string; description: string }, req: AppRequest) {
    const rl = await this.limiter.hit(`dispute:${userId}`, 5, 86_400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const t = await this.trips.load(tripId);
    const role = t ? await this.trips.participantRole(userId, t) : null;
    // Solo quien pidió el viaje o lo condujo; 404 para cualquier otro (no revela que el viaje existe).
    if (!t || (role !== 'requester' && role !== 'driver')) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!['completed', 'cancelled'].includes(t.status)) throw new AppError(409, 'trip_not_finished', 'Solo se reclaman viajes terminados o cancelados');
    const endedAt = t.ended_at ?? t.requested_at;
    if (endedAt && Date.now() - new Date(endedAt).getTime() > WINDOW_DAYS * 86_400_000) throw new AppError(409, 'dispute_window_closed', `El plazo para reclamar es de ${WINDOW_DAYS} días`);
    const id = randomUUID();
    await this.pool
      .query(
        `INSERT INTO support.disputes (id, trip_id, opened_by, opener_role, category, description_enc, status) VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
        [id, tripId, userId, role, input.category, await this.cipher.encrypt(input.description, aad(id))],
      )
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'dispute_exists', 'Ya tienes un reclamo abierto para este viaje') : e;
      });
    await this.audit.record({ action: 'dispute.open', resourceType: 'trip', resourceId: tripId, metadata: { disputeId: id, category: input.category } }, req);
    return { id, status: 'open' };
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, trip_id AS "tripId", category, status, resolution, refund_cents AS "refundCents", created_at AS "createdAt", resolved_at AS "resolvedAt"
       FROM support.disputes WHERE opened_by = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  }

  async list(status: string) {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.trip_id AS "tripId", d.opener_role AS "openerRole", d.category, d.status, d.assigned_to AS "assignedTo", d.created_at AS "createdAt",
         t.type AS "tripType", t.final_fare_cents AS "fareCents", p.id AS "paymentId", p.method AS "paymentMethod"
       FROM support.disputes d JOIN trips.trips t ON t.id = d.trip_id LEFT JOIN payments.payments p ON p.trip_id = d.trip_id
       WHERE d.status = $1 ORDER BY d.created_at LIMIT 100`,
      [status],
    );
    return rows;
  }

  /** Detalle con la descripción descifrada: exige motivo y deja traza con finalidad. */
  async detail(adminId: string, id: string, reason: string, req: AppRequest) {
    const d = (await this.pool.query(`SELECT * FROM support.disputes WHERE id = $1`, [id])).rows[0];
    if (!d) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'dispute.view', resourceType: 'dispute', resourceId: id, actorUserId: adminId, purpose: 'dispute_review', metadata: { reason } }, req);
    const t = await this.trips.load(d.trip_id);
    const pay = (await this.pool.query(`SELECT id, method, status, amount_cents AS "amountCents", refunded_cents AS "refundedCents" FROM payments.payments WHERE trip_id = $1`, [d.trip_id])).rows[0] ?? null;
    return {
      id: d.id, tripId: d.trip_id, openerRole: d.opener_role, category: d.category, status: d.status, assignedTo: d.assigned_to,
      description: await this.cipher.decrypt(d.description_enc, aad(d.id)),
      trip: t ? { type: t.type, status: t.status, distanceM: t.distance_m, quotedFareCents: t.quoted_fare_cents, finalFareCents: t.final_fare_cents, partySize: t.party_size, startedAt: t.started_at, endedAt: t.ended_at } : null,
      payment: pay,
      resolution: d.resolution, refundCents: d.refund_cents, createdAt: d.created_at,
    };
  }

  async assign(adminId: string, id: string, req: AppRequest) {
    const u = await this.pool.query(`UPDATE support.disputes SET status = 'in_review', assigned_to = $2 WHERE id = $1 AND status IN ('open', 'in_review')`, [id, adminId]);
    if (!u.rowCount) throw new AppError(409, 'invalid_state', 'La disputa ya está cerrada');
    await this.audit.record({ action: 'dispute.assign', resourceType: 'dispute', resourceId: id, actorUserId: adminId }, req);
    return { id, status: 'in_review' };
  }

  /** Resolver: con reembolso opcional (vía pagos, con el mismo control de doble gasto) o rechazar. */
  async resolve(adminId: string, id: string, input: { decision: 'resolved' | 'rejected'; resolution: string; refundCents?: number; refundTo?: 'original' | 'wallet' }, req: AppRequest) {
    const d = (await this.pool.query(`SELECT d.*, t.driver_id FROM support.disputes d JOIN trips.trips t ON t.id = d.trip_id WHERE d.id = $1`, [id])).rows[0];
    if (!d) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!['open', 'in_review'].includes(d.status)) throw new AppError(409, 'invalid_state', 'La disputa ya está cerrada');
    // Separación de funciones: nadie resuelve un reclamo de un viaje en el que participó.
    if (d.opened_by === adminId || d.driver_id === adminId) throw new AppError(403, 'conflict_of_interest', 'No puedes resolver un reclamo de un viaje en el que participaste');
    if (input.refundCents && input.decision !== 'resolved') throw new AppError(400, 'invalid_input', 'Solo se reembolsa al resolver a favor');
    // Se reclama la disputa primero (atómico): dos agentes no pueden reembolsar el mismo reclamo.
    const claimed = await this.pool.query(
      `UPDATE support.disputes SET status = $2, resolution = $3, refund_cents = $4, resolved_by = $5, resolved_at = now() WHERE id = $1 AND status IN ('open', 'in_review')`,
      [id, input.decision, input.resolution, input.refundCents ?? null, adminId],
    );
    if (!claimed.rowCount) throw new AppError(409, 'invalid_state', 'La disputa ya está cerrada');
    if (input.refundCents) {
      try {
        const pay = (await this.pool.query<{ id: string }>(`SELECT id FROM payments.payments WHERE trip_id = $1`, [d.trip_id])).rows[0];
        if (!pay) throw new AppError(409, 'not_charged', 'El viaje no tiene cobro que reembolsar');
        await this.payments.refund(adminId, pay.id, input.refundCents, input.refundTo ?? 'original', `Disputa ${id}: ${input.resolution}`, req);
      } catch (e) {
        await this.pool.query(`UPDATE support.disputes SET status = 'in_review', resolution = NULL, refund_cents = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = $1`, [id]);
        throw e;
      }
    }
    await this.audit.record({ action: 'dispute.resolve', resourceType: 'dispute', resourceId: id, actorUserId: adminId, metadata: { decision: input.decision, refundCents: input.refundCents ?? 0 } }, req);
    return { id, status: input.decision, refundCents: input.refundCents ?? null };
  }
}
