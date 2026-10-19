import { Inject, Injectable } from '@nestjs/common';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, REDIS, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { PG_POOL } from '../../tokens.js';

/**
 * Panel de administración — funciones transversales:
 *  - métricas agregadas SIN datos personales;
 *  - visor del log de auditoría y verificación de la cadena de hash (auditor);
 *  - solicitudes de titulares de datos (DPO);
 *  - revisión manual de documentos de identidad duplicados en KYC (fraud_analyst).
 */
@Injectable()
export class BackofficeService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Solo conteos y sumas (día local de Guayaquil). Nada que identifique a una persona. */
  async metrics() {
    const today = `(now() AT TIME ZONE 'America/Guayaquil')::date`;
    const q = async (sql: string) => (await this.pool.query(sql)).rows;
    const [trips, drivers, kyc, incidents, fraud, payouts, disputes, revenue, routes] = await Promise.all([
      q(`SELECT type, status, count(*)::int AS n FROM trips.trips WHERE (requested_at AT TIME ZONE 'America/Guayaquil')::date = ${today} GROUP BY type, status`),
      q(`SELECT status, count(*)::int AS n FROM drivers.profiles GROUP BY status`),
      q(`SELECT count(*)::int AS n FROM kyc.verifications WHERE status = 'duplicate_review'`),
      q(`SELECT status, count(*)::int AS n FROM safety.incidents WHERE status IN ('open', 'acknowledged', 'escalated') GROUP BY status`),
      q(`SELECT count(*)::int AS n FROM payments.fraud_signals WHERE status = 'open'`),
      q(`SELECT count(*)::int AS n FROM payments.payouts WHERE status IN ('requested', 'under_review')`),
      q(`SELECT count(*)::int AS n FROM support.disputes WHERE status IN ('open', 'in_review')`),
      q(`SELECT coalesce(sum(amount_cents - refunded_cents), 0)::bigint AS cents FROM payments.payments WHERE status IN ('approved', 'cash_collected', 'partially_refunded') AND (created_at AT TIME ZONE 'America/Guayaquil')::date = ${today}`),
      q(`SELECT count(*)::int AS n FROM fixed_routes.instances WHERE status = 'in_service'`),
    ]);
    const online = await this.pool.query(`SELECT count(*)::int AS n FROM drivers.online_sessions WHERE ended_at IS NULL`);
    return {
      day: (await this.pool.query(`SELECT ${today}::text AS d`)).rows[0].d,
      timezone: 'America/Guayaquil',
      tripsToday: trips,
      drivers: Object.fromEntries(drivers.map((r) => [r.status, r.n])),
      driversOnline: online.rows[0].n,
      driversAvailable: await this.redis.zcard('drivers:available'),
      routeVehiclesInService: routes[0].n,
      queues: {
        kycDuplicateReview: kyc[0].n,
        incidentsActive: Object.fromEntries(incidents.map((r) => [r.status, r.n])),
        fraudSignalsOpen: fraud[0].n,
        payoutsPending: payouts[0].n,
        disputesOpen: disputes[0].n,
      },
      revenueTodayCents: Number(revenue[0].cents),
    };
  }

  // ---------- Auditoría ----------

  async auditLog(f: { action?: string; resourceType?: string; resourceId?: string; actorUserId?: string; outcome?: string; before?: number; limit: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (f.action) add('action LIKE ?', `${f.action.replace(/[%_]/g, '')}%`);
    if (f.resourceType) add('resource_type = ?', f.resourceType);
    if (f.resourceId) add('resource_id = ?', f.resourceId);
    if (f.actorUserId) add('actor_user_id = ?', f.actorUserId);
    if (f.outcome) add('outcome = ?', f.outcome);
    if (f.before) add('seq < ?', f.before);
    args.push(f.limit);
    const { rows } = await this.pool.query(
      `SELECT seq, ts, actor_user_id AS "actorUserId", actor_role AS "actorRole", action, resource_type AS "resourceType", resource_id AS "resourceId",
         outcome, purpose, request_id AS "requestId", metadata, encode(hash, 'hex') AS hash
       FROM audit.audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT $${args.length}`,
      args,
    );
    return { entries: rows.map((r) => ({ ...r, seq: Number(r.seq) })), nextBefore: rows.length ? Number(rows.at(-1).seq) : null };
  }

  /** Recalcula toda la cadena; devuelve el primer eslabón roto (o ninguno). La consulta en sí queda auditada. */
  async verifyAudit(adminId: string, req: AppRequest) {
    const r = await this.pool.query(`SELECT audit.verify_chain() AS broken, (SELECT count(*) FROM audit.audit_log)::bigint AS total, (SELECT encode(hash, 'hex') FROM audit.audit_log ORDER BY seq DESC LIMIT 1) AS head`);
    const { broken, total, head } = r.rows[0];
    await this.audit.record({ action: 'audit.verify', resourceType: 'audit_log', actorUserId: adminId, outcome: broken === null ? 'success' : 'failure', metadata: { total: Number(total) } }, req);
    return { intact: broken === null, firstBrokenSeq: broken === null ? null : Number(broken), entries: Number(total), headHash: head };
  }

  // ---------- Privacidad (DPO) ----------

  async privacyRequests(status: string) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.type, r.status, r.notes, r.created_at AS "createdAt", r.due_at AS "dueAt", r.resolved_at AS "resolvedAt",
         p.id_doc_masked AS "documentMasked", (p.anonymized_at IS NOT NULL) AS anonymized,
         EXISTS (SELECT 1 FROM trips.trip_parties tp JOIN trips.trips t ON t.id = tp.trip_id WHERE tp.person_id = r.person_id AND (t.incident_hold OR t.status IN ('matching', 'accepted', 'arrived', 'in_progress'))) AS "legalHold"
       FROM people.data_subject_requests r LEFT JOIN people.persons p ON p.id = r.person_id
       WHERE r.status = $1 ORDER BY r.due_at LIMIT 100`,
      [status],
    );
    return rows;
  }

  /**
   * Decisión del DPO. "complete" de una solicitud de borrado anonimiza a la persona, salvo retención legal
   * (incidente o viaje activo): en ese caso no se puede completar. "reject" exige fundamento.
   */
  async decidePrivacy(adminId: string, id: string, decision: 'complete' | 'reject', notes: string, req: AppRequest) {
    return withTransaction(this.pool, async (c) => {
      const r = (await c.query(`SELECT * FROM people.data_subject_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (!['received', 'deferred_legal_hold'].includes(r.status)) throw new AppError(409, 'invalid_state', 'La solicitud ya fue resuelta');
      if (decision === 'complete' && r.type === 'delete' && r.person_id) {
        const hold = await c.query(
          `SELECT 1 FROM trips.trip_parties tp JOIN trips.trips t ON t.id = tp.trip_id WHERE tp.person_id = $1 AND (t.incident_hold OR t.status IN ('matching', 'accepted', 'arrived', 'in_progress'))`,
          [r.person_id],
        );
        if (hold.rowCount) throw new AppError(409, 'legal_hold', 'La persona está en un viaje activo o con incidente: el borrado queda diferido');
        await c.query(
          `UPDATE people.persons SET given_names_enc = NULL, family_names_enc = NULL, id_doc_number_enc = NULL, id_doc_hmac = NULL, id_doc_masked = NULL,
             email_enc = NULL, email_hmac = NULL, phone_enc = NULL, anonymized_at = now() WHERE id = $1 AND anonymized_at IS NULL`,
          [r.person_id],
        );
      }
      const status = decision === 'complete' ? 'completed' : 'rejected';
      await c.query(`UPDATE people.data_subject_requests SET status = $2, notes = $3, resolved_at = now() WHERE id = $1`, [id, status, notes]);
      await this.audit.record({ action: 'privacy.decide', resourceType: 'data_subject_request', resourceId: id, actorUserId: adminId, actorRole: 'dpo', metadata: { decision, type: r.type } }, req, c);
      return { id, status };
    });
  }

  // ---------- KYC: documentos duplicados ----------

  async kycReviews() {
    const { rows } = await this.pool.query(
      `SELECT v.id, v.user_id AS "userId", v.doc_type AS "docType", v.doc_country AS "docCountry", v.doc_number_masked AS "documentMasked", v.risk_score AS "riskScore", v.decided_at AS "flaggedAt",
         (SELECT json_agg(json_build_object('userId', o.user_id, 'approvedAt', o.decided_at)) FROM kyc.verifications o
           WHERE o.doc_number_hmac = v.doc_number_hmac AND o.status = 'approved' AND o.kind = 'full' AND o.user_id <> v.user_id) AS "conflictingAccounts"
       FROM kyc.verifications v WHERE v.status = 'duplicate_review' ORDER BY v.decided_at LIMIT 100`,
    );
    return rows;
  }

  /**
   * - reject: el documento ya pertenece a otra cuenta → se declina y se abre una señal de fraude.
   * - transfer: es la misma persona con una cuenta nueva (p. ej. perdió su número). La prueba de vida y la
   *   comparación facial ya pasaron en el proveedor; se revoca la verificación de la cuenta anterior y se
   *   aprueba esta. Ambas cuentas quedan con una señal para seguimiento.
   */
  async decideKyc(adminId: string, id: string, decision: 'reject' | 'transfer', reason: string, req: AppRequest) {
    return withTransaction(this.pool, async (c) => {
      const v = (await c.query(`SELECT * FROM kyc.verifications WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!v || v.status !== 'duplicate_review') throw new AppError(404, 'not_found', 'No hay una revisión pendiente con ese id');
      if (v.user_id === adminId) throw new AppError(403, 'forbidden', 'No puedes revisar tu propia verificación');
      const others = (await c.query<{ id: string; user_id: string }>(`SELECT id, user_id FROM kyc.verifications WHERE doc_number_hmac = $1 AND status = 'approved' AND kind = 'full' AND user_id <> $2 FOR UPDATE`, [v.doc_number_hmac, v.user_id])).rows;
      if (others.some((o) => o.user_id === adminId)) throw new AppError(403, 'forbidden', 'Conflicto de interés: el documento está en tu propia cuenta');
      const signal = (subject: string, name: string, score: number) =>
        c.query(`INSERT INTO payments.fraud_signals (id, subject_type, subject_id, signal, score, data) VALUES ($1, 'user', $2, $3, $4, $5)`, [randomUUID(), subject, name, score, { verificationId: id }]);
      if (decision === 'reject') {
        await c.query(`UPDATE kyc.verifications SET status = 'declined', reason = 'duplicate_document_rejected' WHERE id = $1`, [id]);
        await signal(v.user_id, 'kyc_duplicate_document', 80);
      } else {
        for (const o of others) {
          await c.query(`UPDATE kyc.verifications SET status = 'revoked', reason = 'identity_transferred' WHERE id = $1`, [o.id]);
          await signal(o.user_id, 'kyc_identity_transferred_out', 40);
        }
        await c.query(`UPDATE kyc.verifications SET status = 'superseded' WHERE user_id = $1 AND kind = 'full' AND status = 'approved'`, [v.user_id]);
        await c.query(`UPDATE kyc.verifications SET status = 'approved', reason = 'duplicate_transfer_approved' WHERE id = $1`, [id]);
        await signal(v.user_id, 'kyc_identity_transferred_in', 30);
      }
      await this.audit.record({ action: 'kyc.duplicate_decision', resourceType: 'kyc_verification', resourceId: id, actorUserId: adminId, actorRole: 'fraud_analyst', metadata: { decision, reason, otherAccounts: others.length } }, req, c);
      return { id, status: decision === 'reject' ? 'declined' : 'approved' };
    });
  }
}
