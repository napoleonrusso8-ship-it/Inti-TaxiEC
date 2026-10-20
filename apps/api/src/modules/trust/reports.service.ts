import { Inject, Injectable } from '@nestjs/common';
import type { FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, REDIS, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { StoragePort } from '../../infra/storage.js';
import { FIELD_CIPHER, PG_POOL, STORAGE } from '../../tokens.js';
import { ChatService } from '../chat/chat.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PresenceService } from '../trips/presence.service.js';
import { TripsService } from '../trips/trips.service.js';

export type ReportCategory = 'mistreatment' | 'discrimination' | 'harassment' | 'threats' | 'unsafe_driving' | 'other';
const HIGH: ReportCategory[] = ['discrimination', 'harassment', 'threats'];
const REPORT_WINDOW_DAYS = 30;
const aad = (id: string, field: string) => `support.reports.${field}:${id}`;
const actionAad = (reportId: string) => `support.report_actions.note:${reportId}`;

/**
 * Reportes de malos tratos entre pasajero y conductor (en ambos sentidos).
 * Debido proceso: un agente de confianza y seguridad revisa las pruebas (chat, archivos, viaje),
 * se comunica con la persona reportada ANTES de sancionar, y la expulsión exige una segunda aprobación.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------- Usuario ----------

  async create(userId: string, tripId: string, input: { category: ReportCategory; description: string; evidenceMediaIds: string[] }, req: AppRequest) {
    const rl = await this.limiter.hit(`report:${userId}`, 5, 86_400);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const t = await this.trips.load(tripId);
    const role = t ? await this.trips.participantRole(userId, t) : null;
    if (!t || !role || !t.driver_id) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const end = t.ended_at ?? null;
    if (end && Date.now() - end.getTime() > REPORT_WINDOW_DAYS * 86400_000) throw new AppError(409, 'report_window_closed', `Puedes reportar hasta ${REPORT_WINDOW_DAYS} días después del viaje`);
    const asDriver = role === 'driver';
    const reported = asDriver ? t.requester_user_id : t.driver_id;
    if (input.evidenceMediaIds.length) {
      const ok = await this.pool.query(`SELECT count(*)::int AS n FROM trips.chat_media WHERE trip_id = $1 AND id = ANY($2) AND status = 'ready'`, [tripId, input.evidenceMediaIds]);
      if (ok.rows[0].n !== input.evidenceMediaIds.length) throw new AppError(400, 'invalid_evidence', 'Las pruebas deben ser archivos del chat de este viaje');
    }
    const chat = await this.redis.lrange(`rt:chat:${tripId}`, 0, 199);
    const id = randomUUID();
    await this.pool
      .query(
        `INSERT INTO support.reports (id, trip_id, reporter_user_id, reporter_role, reported_user_id, reported_role, category, priority, description_enc, chat_snapshot_enc, evidence_media_ids, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')`,
        [
          id, tripId, userId, asDriver ? 'driver' : 'passenger', reported, asDriver ? 'passenger' : 'driver', input.category, HIGH.includes(input.category) ? 'high' : 'normal',
          await this.cipher.encrypt(input.description, aad(id, 'description')),
          chat.length ? await this.cipher.encrypt(JSON.stringify(chat.map((m) => JSON.parse(m)).reverse()), aad(id, 'chat')) : null,
          input.evidenceMediaIds,
        ],
      )
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'report_exists', 'Ya reportaste este viaje') : e;
      });
    // Las pruebas no se borran mientras el caso esté abierto.
    await this.chat.hold(tripId);
    await this.audit.record({ action: 'report.create', resourceType: 'trip', resourceId: tripId, metadata: { reportId: id, category: input.category } }, req);
    return { id, status: 'open', message: 'Recibimos tu reporte. Un agente revisará las pruebas y te contactará.' };
  }

  async mine(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, trip_id AS "tripId", category, status, created_at AS "createdAt", resolved_at AS "resolvedAt" FROM support.reports WHERE reporter_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  }

  // ---------- Agente (trust_safety) ----------

  async list(status: string) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.trip_id AS "tripId", r.category, r.priority, r.status, r.reporter_role AS "reporterRole", r.reported_role AS "reportedRole", r.assigned_to AS "assignedTo", r.created_at AS "createdAt",
         cardinality(r.evidence_media_ids) AS "evidenceCount",
         (SELECT count(*)::int FROM support.reports x WHERE x.reported_user_id = r.reported_user_id) AS "reportsAgainstReported"
       FROM support.reports r WHERE r.status = $1 ORDER BY (r.priority = 'high') DESC, r.created_at LIMIT 100`,
      [status],
    );
    return rows;
  }

  async #load(id: string) {
    const r = (await this.pool.query(`SELECT * FROM support.reports WHERE id = $1`, [id])).rows[0];
    if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return r;
  }

  /** Expediente completo para el agente. Acceso auditado con motivo. */
  async detail(adminId: string, id: string, reason: string, req: AppRequest) {
    const r = await this.#load(id);
    await this.audit.record({ action: 'report.view', resourceType: 'report', resourceId: id, actorUserId: adminId, purpose: 'trust_investigation', metadata: { reason } }, req);
    const evidence = await this.pool.query(`SELECT id, kind, content_type, storage_key, duration_ms, status FROM trips.chat_media WHERE trip_id = $1 AND status = 'ready' ORDER BY created_at`, [r.trip_id]);
    const actions = await this.pool.query(`SELECT action, actor_user_id AS "actorUserId", note_enc, created_at AS "at" FROM support.report_actions WHERE report_id = $1 ORDER BY id`, [id]);
    const t = await this.trips.load(r.trip_id);
    const priorSanctions = await this.pool.query(`SELECT type, status, reason, created_at AS "at" FROM support.sanctions WHERE user_id = $1 ORDER BY created_at DESC`, [r.reported_user_id]);
    return {
      id, tripId: r.trip_id, category: r.category, priority: r.priority, status: r.status, reporterRole: r.reporter_role, reportedRole: r.reported_role,
      description: await this.cipher.decrypt(r.description_enc, aad(id, 'description')),
      chat: r.chat_snapshot_enc ? JSON.parse(await this.cipher.decrypt(r.chat_snapshot_enc, aad(id, 'chat'))) : [],
      evidence: await Promise.all(
        evidence.rows.map(async (m) => ({ mediaId: m.id, kind: m.kind, durationMs: m.duration_ms, selectedByReporter: r.evidence_media_ids.includes(m.id), url: await this.storage.createDownloadUrl(m.storage_key, 300) })),
      ),
      trip: t ? { type: t.type, status: t.status, startedAt: t.started_at, endedAt: t.ended_at, distanceM: t.distance_m } : null,
      reported: r.reported_role === 'driver' ? await this.trips.driverCard(r.reported_user_id, t?.vehicle_id ?? null) : await this.trips.passengerCard(r.reported_user_id),
      priorSanctions: priorSanctions.rows,
      actions: await Promise.all(actions.rows.map(async (a) => ({ action: a.action, actorUserId: a.actorUserId, at: a.at, note: a.note_enc ? await this.cipher.decrypt(a.note_enc, actionAad(id)) : null }))),
      resolution: r.resolution,
    };
  }

  async #conflict(adminId: string, r: { reporter_user_id: string; reported_user_id: string }) {
    if (adminId === r.reporter_user_id || adminId === r.reported_user_id) throw new AppError(403, 'conflict_of_interest', 'No puedes atender un caso en el que eres parte');
  }

  async #log(reportId: string, adminId: string, action: string, note: string | null, c?: { query: Pool['query'] }) {
    await (c ?? this.pool).query(`INSERT INTO support.report_actions (report_id, actor_user_id, action, note_enc) VALUES ($1, $2, $3, $4)`, [reportId, adminId, action, note ? await this.cipher.encrypt(note, actionAad(reportId)) : null]);
  }

  async assign(adminId: string, id: string, req: AppRequest) {
    const r = await this.#load(id);
    await this.#conflict(adminId, r);
    if (!['open', 'investigating'].includes(r.status)) throw new AppError(409, 'invalid_state', 'El caso ya está cerrado');
    await this.pool.query(`UPDATE support.reports SET status = 'investigating', assigned_to = $2 WHERE id = $1`, [id, adminId]);
    await this.#log(id, adminId, 'assign', null);
    await this.audit.record({ action: 'report.assign', resourceType: 'report', resourceId: id, actorUserId: adminId }, req);
    return { id, status: 'investigating' };
  }

  /** Registro de contactos con las partes y notas del caso. */
  async addAction(adminId: string, id: string, action: 'contact_reported' | 'contact_reporter' | 'note', note: string, req: AppRequest) {
    const r = await this.#load(id);
    await this.#conflict(adminId, r);
    if (!['open', 'investigating'].includes(r.status)) throw new AppError(409, 'invalid_state', 'El caso ya está cerrado');
    await this.#log(id, adminId, action, note);
    await this.audit.record({ action: `report.${action}`, resourceType: 'report', resourceId: id, actorUserId: adminId }, req);
    return { id, action };
  }

  /**
   * Decisión del caso. Para sancionar hace falta haber escuchado a la persona reportada (contacto
   * registrado). Advertencia y suspensión (1–30 días) son inmediatas; la expulsión queda pendiente de
   * aprobación de otra persona.
   */
  async decide(adminId: string, id: string, input: { decision: 'dismissed' | 'warning' | 'suspension' | 'ban'; days?: number; resolution: string }, req: AppRequest) {
    const out = await withTransaction(this.pool, async (c) => {
      const r = (await c.query(`SELECT * FROM support.reports WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      await this.#conflict(adminId, r);
      if (!['open', 'investigating'].includes(r.status)) throw new AppError(409, 'invalid_state', 'El caso ya está cerrado');
      let sanction: { id: string; status: string } | null = null;
      if (input.decision !== 'dismissed') {
        const heard = await c.query(`SELECT 1 FROM support.report_actions WHERE report_id = $1 AND action = 'contact_reported'`, [id]);
        if (!heard.rowCount) throw new AppError(409, 'contact_required', 'Antes de sancionar, comunícate con la persona reportada y registra el contacto');
        if (input.decision === 'suspension' && (!input.days || input.days < 1 || input.days > 30)) throw new AppError(400, 'invalid_input', 'La suspensión debe ser de 1 a 30 días');
        const sid = randomUUID();
        const status = input.decision === 'ban' ? 'pending_approval' : 'active';
        await c.query(
          `INSERT INTO support.sanctions (id, user_id, subject_role, type, status, reason, report_id, ends_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [sid, r.reported_user_id, r.reported_role, input.decision, status, input.resolution, id, input.decision === 'suspension' ? new Date(Date.now() + input.days! * 86400_000) : null, adminId],
        );
        sanction = { id: sid, status };
      }
      await c.query(`UPDATE support.reports SET status = $2, resolution = $3, resolved_at = now() WHERE id = $1`, [id, input.decision === 'dismissed' ? 'dismissed' : 'resolved', input.resolution]);
      await this.#log(id, adminId, 'decision', `${input.decision}${input.days ? ` ${input.days} días` : ''}: ${input.resolution}`, c);
      await this.audit.record({ action: 'report.decide', resourceType: 'report', resourceId: id, actorUserId: adminId, actorRole: 'trust_safety', metadata: { decision: input.decision, days: input.days ?? null } }, req, c);
      return { r, sanction };
    });
    if (out.sanction?.status === 'active') await this.#enforce(out.r.reported_user_id, out.r.reported_role, input.decision as 'warning' | 'suspension');
    await this.notify.notifyUser(out.r.reporter_user_id, 'report_resolved', { sms: 'Inti Taxi: revisamos tu reporte y tomamos las medidas correspondientes. Gracias por ayudarnos a cuidar la comunidad.' });
    return { id, status: input.decision === 'dismissed' ? 'dismissed' : 'resolved', sanction: out.sanction };
  }

  async approveSanction(adminId: string, sanctionId: string, req: AppRequest) {
    const s = await withTransaction(this.pool, async (c) => {
      const row = (await c.query(`SELECT * FROM support.sanctions WHERE id = $1 FOR UPDATE`, [sanctionId])).rows[0];
      if (!row || row.status !== 'pending_approval') throw new AppError(404, 'not_found', 'No hay una sanción pendiente con ese id');
      if (row.created_by === adminId) throw new AppError(403, 'four_eyes', 'Otra persona debe aprobar la expulsión que propusiste');
      if (row.user_id === adminId) throw new AppError(403, 'conflict_of_interest', 'No puedes aprobar una sanción sobre ti');
      await c.query(`UPDATE support.sanctions SET status = 'active', approved_by = $2 WHERE id = $1`, [sanctionId, adminId]);
      await this.audit.record({ action: 'sanction.approve', resourceType: 'sanction', resourceId: sanctionId, actorUserId: adminId }, req, c);
      return row;
    });
    await this.#enforce(s.user_id, s.subject_role, 'ban');
    return { id: sanctionId, status: 'active' };
  }

  /** Apelación aceptada o error: la sanción deja de aplicarse (queda el registro). */
  async revokeSanction(adminId: string, sanctionId: string, reason: string, req: AppRequest) {
    const u = await this.pool.query(`UPDATE support.sanctions SET status = 'revoked', revoked_by = $2, revoked_at = now() WHERE id = $1 AND status <> 'revoked' RETURNING user_id`, [sanctionId, adminId]);
    if (!u.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'sanction.revoke', resourceType: 'sanction', resourceId: sanctionId, actorUserId: adminId, metadata: { reason } }, req);
    return { id: sanctionId, status: 'revoked' };
  }

  /** Aplica la sanción: aviso a la persona y, si es conductor suspendido/expulsado y está libre, se desconecta. */
  async #enforce(userId: string, role: 'passenger' | 'driver', type: 'warning' | 'suspension' | 'ban') {
    if (role === 'driver' && type !== 'warning') {
      const st = await this.presence.state(userId);
      if (st && !st.tripId) {
        await this.presence.goOffline(userId);
        await this.pool.query('UPDATE drivers.online_sessions SET ended_at = now() WHERE driver_id = $1 AND ended_at IS NULL', [userId]);
      }
    }
    const text: Record<string, string> = {
      warning: 'Inti Taxi: recibiste una advertencia por un reporte comprobado de mal trato. Una nueva falta puede suspender tu cuenta.',
      suspension: 'Inti Taxi: tu cuenta fue suspendida temporalmente por un reporte comprobado de mal trato. Puedes apelar con soporte.',
      ban: 'Inti Taxi: tu cuenta fue dada de baja por incumplir las normas de convivencia. Puedes apelar con soporte.',
    };
    await this.notify.notifyUser(userId, `sanction_${type}`, { sms: text[type] });
  }
}
