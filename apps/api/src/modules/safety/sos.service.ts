import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { constantTimeEqual, keyedMac, randomToken, sha256, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, internalFetch, REDIS, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { StoragePort } from '../../infra/storage.js';
import { CONFIG, ECU911, FIELD_CIPHER, PG_POOL, STORAGE } from '../../tokens.js';
import type { Ecu911Port } from './ecu911.js';
import { ManifestService } from './manifest.service.js';

type Actor = { kind: 'user'; userId: string; role: 'requester' | 'passenger' | 'driver' } | { kind: 'link'; tripId: string } | { kind: 'operator'; userId: string } | { kind: 'system'; reason: string };

const actorRole = (a: Actor) => (a.kind === 'user' ? a.role : a.kind === 'link' ? 'link_holder' : a.kind === 'system' ? 'system' : 'operator');
const actorId = (a: Actor) => (a.kind === 'user' || a.kind === 'operator' ? a.userId : null);
interface Loc {
  lat: number;
  lng: number;
}

const ACTIVE = ['open', 'acknowledged', 'escalated'];

@Injectable()
export class SosService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('SOS');
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #pepper: Buffer;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ECU911) private readonly ecu: Ecu911Port,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.#pepper = Buffer.from(config.SAFETY_PIN_PEPPER, 'base64');
  }

  onModuleInit() {
    this.#timers.push(setInterval(() => void this.autoEscalate().catch((e) => this.#log.error(e.message)), 5_000));
    this.#timers.push(setInterval(() => void this.syncOperators().catch(() => {}), 30_000));
    this.#timers.forEach((t) => t.unref());
    void this.syncOperators().catch(() => {});
  }

  onModuleDestroy() {
    this.#timers.forEach(clearInterval);
  }

  /** Lista de operadores autorizados al canal "ops:incidents" del gateway de tiempo real. */
  async syncOperators() {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM admin.role_assignments WHERE role IN ('sos_operator', 'super_admin') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    const m = this.redis.multi().del('rt:ops:members');
    if (rows.length) m.sadd('rt:ops:members', ...rows.map((r) => r.user_id));
    await m.exec();
  }

  async #publishOps(msg: Record<string, unknown>) {
    await this.redis.publish('rt:ops:incidents', JSON.stringify({ type: 'incident', ...msg, at: new Date().toISOString() }));
  }

  async #event(incidentId: string, kind: string, actor: Actor, data: Record<string, unknown> = {}) {
    await this.pool.query('INSERT INTO safety.sos_events (incident_id, kind, actor_role, actor_id, data) VALUES ($1, $2, $3, $4, $5)', [
      incidentId, kind, actorRole(actor), actorId(actor), data,
    ]);
  }

  /** ¿Puede este usuario activar el SOS del viaje? Solicitante, pasajero con cuenta o conductor asignado. */
  async userRole(userId: string, tripId: string): Promise<'requester' | 'passenger' | 'driver' | null> {
    const t = (await this.pool.query('SELECT requester_user_id, driver_id FROM trips.trips WHERE id = $1', [tripId])).rows[0];
    if (!t) return null;
    if (t.driver_id === userId) return 'driver';
    if (t.requester_user_id === userId) return 'requester';
    const p = await this.pool.query('SELECT 1 FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 AND p.user_id = $2', [tripId, userId]);
    return p.rowCount ? 'passenger' : null;
  }

  /** Enlace de seguimiento (tercero/acompañante): también puede activar el SOS. */
  async tripFromLink(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.pool.query<{ trip_id: string }>(
      `SELECT trip_id FROM trips.share_links WHERE token_hash = $1 AND audience IN ('third_party', 'companion') AND revoked_at IS NULL AND expires_at > now()`,
      [sha256(token)],
    );
    return rows[0]?.trip_id ?? null;
  }

  /**
   * Activación. La app YA marcó el 911 desde el teléfono; aquí: incidente (uno por viaje), retención legal,
   * manifiesto de incidente, aviso a contactos de confianza y al centro de monitoreo, y escalamiento a ECU 911
   * (por el operador o automáticamente si nadie atiende).
   */
  async activate(tripId: string, actor: Actor, type: 'sos' | 'accident', location: Loc | null, req?: AppRequest) {
    const trip = (await this.pool.query('SELECT id, status, requester_user_id, driver_id, vehicle_id FROM trips.trips WHERE id = $1', [tripId])).rows[0];
    if (!trip) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!['accepted', 'arrived', 'in_progress', 'completed'].includes(trip.status)) throw new AppError(409, 'trip_not_active', 'El viaje no está activo');
    const existing = (await this.pool.query(`SELECT id FROM safety.incidents WHERE trip_id = $1 AND status = ANY($2)`, [tripId, ACTIVE])).rows[0];
    let incidentId: string = existing?.id;
    if (!incidentId) {
      incidentId = randomUUID();
      const role = actorRole(actor);
      try {
        await withTransaction(this.pool, async (c) => {
          await c.query(
            `INSERT INTO safety.incidents (id, trip_id, type, status, opened_by_user_id, opened_by_role) VALUES ($1, $2, $3, 'open', $4, $5)`,
            [incidentId, tripId, type, actorId(actor), role],
          );
          // Retención legal: los datos del viaje no se borran mientras haya incidente.
          await c.query('UPDATE trips.trips SET incident_hold = true WHERE id = $1', [tripId]);
          await this.audit.record({ action: `incident.${type}`, resourceType: 'trip', resourceId: tripId, actorUserId: actorId(actor), actorRole: role, metadata: { incidentId, ...(actor.kind === 'system' ? { reason: actor.reason } : {}) } }, req, c);
        });
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        incidentId = (await this.pool.query(`SELECT id FROM safety.incidents WHERE trip_id = $1 AND status = ANY($2)`, [tripId, ACTIVE])).rows[0].id;
      }
      // El chat del viaje (texto y archivos) se conserva como prueba mientras dure el incidente.
      await this.redis.persist(`rt:chat:${tripId}`);
      await this.#event(incidentId, 'activated', actor, { type, location });
      await this.manifests.snapshot(tripId, 'incident');
      await this.#alertContacts(incidentId, trip, actor);
      await this.#publishOps({ incidentId, tripId, kind: type, status: 'open', location });
    } else {
      await this.#event(incidentId, 'reactivated', actor, { location });
    }
    if (location) await this.location(incidentId, actor, location);
    return { incidentId, status: 'open', call: 'tel:911', instructions: 'Mantén la llamada al 911. Tu ubicación se comparte con el centro de monitoreo de Inti Taxi.' };
  }

  async #alertContacts(incidentId: string, trip: { id: string; requester_user_id: string; driver_id: string | null; vehicle_id: string | null }, actor: Actor) {
    const userId = actor.kind === 'user' && actor.role !== 'driver' ? actor.userId : trip.requester_user_id;
    const plate = trip.vehicle_id ? (await this.pool.query('SELECT plate FROM drivers.vehicles WHERE id = $1', [trip.vehicle_id])).rows[0]?.plate : null;
    const token = randomToken(32);
    const hash = sha256(token);
    await this.pool.query(
      `INSERT INTO trips.share_links (id, trip_id, audience, token_hash, expires_at, created_by) VALUES ($1, $2, 'trusted_contact', $3, now() + interval '12 hours', NULL)`,
      [randomUUID(), trip.id, hash],
    );
    await this.redis.set(`rt:share:${hash.toString('base64url')}`, trip.id, 'EX', 12 * 3600);
    const link = `${this.config.TRACKING_BASE_URL}/t/${token}`;
    try {
      await internalFetch(Buffer.from(this.config.INTERNAL_SIGNING_SECRET, 'base64'), 'sos', this.config.INTERNAL_AUTH_URL, 'POST', '/internal/v1/trusted-contacts/alert', {
        userId, incidentId,
        message: `Inti Taxi — ALERTA: tu contacto activó el botón de emergencia en un taxi${plate ? ` (placa ${plate})` : ''}. Ubicación en vivo: ${link} . Si no logras comunicarte, llama al 911.`,
      });
    } catch (e) {
      this.#log.error(`no se pudo alertar a contactos de confianza: ${(e as Error).message}`);
    }
  }

  async #incidentFor(incidentId: string, actor: Actor) {
    const inc = (await this.pool.query('SELECT * FROM safety.incidents WHERE id = $1', [incidentId])).rows[0];
    if (!inc) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const allowed =
      actor.kind === 'operator' ||
      (actor.kind === 'link' && actor.tripId === inc.trip_id) ||
      (actor.kind === 'user' && !!(await this.userRole(actor.userId, inc.trip_id)));
    if (!allowed) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return inc;
  }

  /** Ubicación en vivo durante el incidente (cada pocos segundos): ruta, operadores y ECU 911 si ya se escaló. */
  async location(incidentId: string, actor: Actor, loc: Loc) {
    const inc = await this.#incidentFor(incidentId, actor);
    if (!ACTIVE.includes(inc.status)) return { status: inc.status };
    await this.pool.query(`INSERT INTO trips.trip_locations (trip_id, at, lat, lng, source) VALUES ($1, now(), $2, $3, 'sos')`, [inc.trip_id, loc.lat, loc.lng]);
    await this.redis.publish(`rt:trip:${inc.trip_id}`, JSON.stringify({ type: 'location', source: 'sos', lat: loc.lat, lng: loc.lng, at: new Date().toISOString() }));
    await this.#publishOps({ incidentId, tripId: inc.trip_id, kind: 'location', location: loc });
    if (inc.ecu911_ref && ['sent', 'simulated'].includes(inc.ecu911_status)) await this.ecu.updateLocation(inc.ecu911_ref, loc).catch(() => {});
    return { status: inc.status };
  }

  /** Audio del teléfono del activador (solo con consentimiento previo), cifrado y con retención de 90 días. */
  async audio(incidentId: string, auth: AuthContext, seq: number, contentType: string, data: Buffer) {
    await this.#incidentFor(incidentId, { kind: 'user', userId: auth.userId, role: 'passenger' });
    const consent = await this.pool.query(`SELECT action FROM kyc.current_consents WHERE user_id = $1 AND purpose = 'audio_recording'`, [auth.userId]);
    if (consent.rows[0]?.action !== 'grant') throw new AppError(403, 'consent_required', 'No autorizaste la grabación de audio');
    if (!data.length || data.length > 256 * 1024) throw new AppError(413, 'payload_too_large', 'Fragmento demasiado grande');
    const id = randomUUID();
    const key = `incidents/${incidentId}/audio/${id}`;
    // Cifrado de aplicación además del cifrado del almacenamiento (SSE-KMS).
    const enc = await this.cipher.encrypt(data.toString('base64'), `safety.audio:${id}`);
    await this.storage.put(key, enc);
    await this.pool.query(`INSERT INTO safety.audio_chunks (id, incident_id, seq, storage_key, content_type, sha256, size_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, incidentId, seq, key, contentType, sha256(data), data.length])
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'duplicate_chunk', 'Fragmento repetido') : e;
      });
    return { id, seq };
  }

  // ---------- PIN de seguridad / coacción ----------

  #mac(userId: string, pin: string) {
    return keyedMac(this.#pepper, `safety-pin:${userId}`, pin);
  }

  async setPins(userId: string, pin: string, duressPin: string, currentPin: string | undefined, req: AppRequest) {
    if (pin === duressPin) throw new AppError(400, 'pins_must_differ', 'El PIN de coacción debe ser distinto');
    const cur = (await this.pool.query<{ pin_mac: Buffer }>('SELECT pin_mac FROM safety.safety_pins WHERE user_id = $1', [userId])).rows[0];
    if (cur && (!currentPin || !constantTimeEqual(this.#mac(userId, currentPin), cur.pin_mac))) throw new AppError(403, 'invalid_pin', 'PIN actual incorrecto');
    await this.pool.query(
      `INSERT INTO safety.safety_pins (user_id, pin_mac, duress_mac) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET pin_mac = EXCLUDED.pin_mac, duress_mac = EXCLUDED.duress_mac, updated_at = now()`,
      [userId, this.#mac(userId, pin), this.#mac(userId, duressPin)],
    );
    await this.audit.record({ action: 'safety.pins_set', resourceType: 'user', resourceId: userId }, req);
    return { configured: true };
  }

  /**
   * Cancelar el SOS ("estoy bien"). Con el PIN de coacción la respuesta es IDÉNTICA a una cancelación normal,
   * pero el incidente se agrava a crítico y se escala de inmediato (por si alguien obliga a cancelar).
   */
  async cancel(incidentId: string, auth: AuthContext, pin: string, req: AppRequest) {
    const inc = await this.#incidentFor(incidentId, { kind: 'user', userId: auth.userId, role: 'passenger' });
    if (inc.opened_by_user_id !== auth.userId) throw new AppError(403, 'forbidden', 'Solo quien activó la alerta puede cancelarla');
    const pins = (await this.pool.query<{ pin_mac: Buffer; duress_mac: Buffer }>('SELECT * FROM safety.safety_pins WHERE user_id = $1', [auth.userId])).rows[0];
    if (!pins) throw new AppError(409, 'no_safety_pin', 'Sin PIN de seguridad: el centro de monitoreo cerrará la alerta');
    const mac = this.#mac(auth.userId, pin);
    const normal = constantTimeEqual(mac, pins.pin_mac);
    const duress = constantTimeEqual(mac, pins.duress_mac);
    if (!normal && !duress) {
      await this.#event(incidentId, 'cancel_failed', { kind: 'user', userId: auth.userId, role: 'passenger' });
      throw new AppError(400, 'invalid_pin', 'PIN incorrecto');
    }
    if (duress) {
      await this.pool.query(`UPDATE safety.incidents SET duress = true, severity = 'critical' WHERE id = $1`, [incidentId]);
      await this.#event(incidentId, 'duress_cancel', { kind: 'user', userId: auth.userId, role: 'passenger' });
      await this.audit.record({ action: 'incident.duress', resourceType: 'incident', resourceId: incidentId }, req);
      await this.#publishOps({ incidentId, tripId: inc.trip_id, kind: 'duress', status: inc.status, severity: 'critical' });
      if (inc.status !== 'escalated') await this.escalate(incidentId, null, req);
    } else {
      await this.pool.query(`UPDATE safety.incidents SET status = 'cancelled_by_user', closed_at = now(), resolution = 'Cancelado por el usuario con su PIN' WHERE id = $1 AND status = ANY($2)`, [incidentId, ACTIVE]);
      await this.#event(incidentId, 'cancelled', { kind: 'user', userId: auth.userId, role: 'passenger' });
      if (inc.ecu911_ref) await this.ecu.close(inc.ecu911_ref, 'cancelado_por_usuario').catch(() => {});
      await this.#publishOps({ incidentId, tripId: inc.trip_id, kind: 'cancelled', status: 'cancelled_by_user' });
      await this.audit.record({ action: 'incident.cancel', resourceType: 'incident', resourceId: incidentId }, req);
    }
    return { incidentId, status: 'cancelled' };
  }

  async status(incidentId: string, actor: Actor) {
    const inc = await this.#incidentFor(incidentId, actor);
    // Nunca se revela el estado de coacción a quien consulta desde el teléfono.
    return { incidentId: inc.id, status: inc.duress ? 'cancelled' : inc.status === 'cancelled_by_user' ? 'cancelled' : inc.status };
  }

  // ---------- Centro de monitoreo ----------

  async escalate(incidentId: string, operatorId: string | null, req?: AppRequest) {
    const inc = (await this.pool.query('SELECT * FROM safety.incidents WHERE id = $1', [incidentId])).rows[0];
    if (!inc) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!ACTIVE.includes(inc.status) && !inc.duress) throw new AppError(409, 'not_active', 'El incidente no está activo');
    const m = await this.manifests.snapshot(inc.trip_id, 'incident');
    const lastLoc = (await this.pool.query(`SELECT lat::float8 AS lat, lng::float8 AS lng FROM trips.trip_locations WHERE trip_id = $1 ORDER BY at DESC LIMIT 1`, [inc.trip_id])).rows[0] ?? null;
    const r = await this.ecu.reportEmergency({ incidentId, type: inc.type, duress: inc.duress, location: lastLoc, manifest: m.payload, manifestSignature: { chainHash: m.chainHash, signature: m.signature, keyId: m.keyId } });
    await this.pool.query(`UPDATE safety.incidents SET status = 'escalated', escalated_at = now(), ecu911_status = $2, ecu911_ref = $3 WHERE id = $1`, [incidentId, r.status, r.ref ?? null]);
    await this.#event(incidentId, 'escalated', operatorId ? { kind: 'operator', userId: operatorId } : { kind: 'link', tripId: inc.trip_id }, { ecu911: r.status, mode: this.ecu.mode, automatic: !operatorId });
    await this.audit.record({ action: 'incident.escalate_ecu911', resourceType: 'incident', resourceId: incidentId, actorUserId: operatorId, actorRole: operatorId ? 'sos_operator' : 'system', metadata: { ecu911: r.status, mode: this.ecu.mode } }, req);
    await this.#publishOps({ incidentId, tripId: inc.trip_id, kind: 'escalated', status: 'escalated', ecu911: r.status });
    return { incidentId, ecu911: r.status, ref: r.ref ?? null };
  }

  /** Fail-safe: si ningún operador atiende en N segundos, se escala solo. */
  async autoEscalate() {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM safety.incidents WHERE status = 'open' AND opened_at < now() - make_interval(secs => $1) LIMIT 20`,
      [this.config.ECU911_AUTO_ESCALATE_SECONDS],
    );
    for (const r of rows) await this.escalate(r.id, null).catch((e) => this.#log.error(e.message));
  }

  async acknowledge(incidentId: string, operatorId: string, req: AppRequest) {
    const r = await this.pool.query(`UPDATE safety.incidents SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'open'`, [incidentId, operatorId]);
    if (!r.rowCount) throw new AppError(409, 'not_open', 'El incidente no está abierto');
    await this.#event(incidentId, 'acknowledged', { kind: 'operator', userId: operatorId });
    await this.audit.record({ action: 'incident.acknowledge', resourceType: 'incident', resourceId: incidentId, actorRole: 'sos_operator' }, req);
    return { incidentId, status: 'acknowledged' };
  }

  async close(incidentId: string, operatorId: string, resolution: string, legalHoldDays: number, req: AppRequest) {
    const inc = (await this.pool.query('SELECT * FROM safety.incidents WHERE id = $1', [incidentId])).rows[0];
    if (!inc) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.pool.query(
      `UPDATE safety.incidents SET status = 'closed', closed_by = $2, closed_at = now(), resolution = $3, legal_hold_until = CASE WHEN $4 > 0 THEN now() + make_interval(days => $4) END WHERE id = $1`,
      [incidentId, operatorId, resolution, legalHoldDays],
    );
    if (inc.ecu911_ref) await this.ecu.close(inc.ecu911_ref, resolution).catch(() => {});
    await this.#event(incidentId, 'closed', { kind: 'operator', userId: operatorId }, { resolution, legalHoldDays });
    await this.audit.record({ action: 'incident.close', resourceType: 'incident', resourceId: incidentId, actorRole: 'sos_operator', metadata: { legalHoldDays } }, req);
    return { incidentId, status: 'closed' };
  }

  async list(status: string) {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.trip_id AS "tripId", i.type, i.status, i.severity, i.duress, i.opened_by_role AS "openedBy", i.opened_at AS "openedAt", i.ecu911_status AS "ecu911",
              (SELECT json_build_object('lat', lat::float8, 'lng', lng::float8, 'at', at) FROM trips.trip_locations l WHERE l.trip_id = i.trip_id ORDER BY at DESC LIMIT 1) AS "lastLocation"
       FROM safety.incidents i WHERE i.status = ANY($1) ORDER BY (i.severity = 'critical') DESC, i.opened_at DESC LIMIT 100`,
      [status === 'active' ? ACTIVE : [status]],
    );
    return rows;
  }

  /** Detalle para el operador: manifiesto descifrado (acceso auditado con finalidad). */
  async detail(incidentId: string, operatorId: string, req: AppRequest) {
    const inc = (await this.pool.query('SELECT * FROM safety.incidents WHERE id = $1', [incidentId])).rows[0];
    if (!inc) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const events = (await this.pool.query('SELECT kind, actor_role, data, at FROM safety.sos_events WHERE incident_id = $1 ORDER BY id', [incidentId])).rows;
    const audio = (await this.pool.query('SELECT id, seq, size_bytes, created_at FROM safety.audio_chunks WHERE incident_id = $1 ORDER BY seq', [incidentId])).rows;
    const chat = (await this.redis.lrange(`rt:chat:${inc.trip_id}`, 0, 199)).map((m) => JSON.parse(m)).reverse();
    await this.audit.record({ action: 'incident.view', resourceType: 'incident', resourceId: incidentId, actorUserId: operatorId, actorRole: 'sos_operator', purpose: 'sos_response' }, req);
    return { incident: inc, events, audio, chat, manifest: await this.manifests.latest(inc.trip_id) };
  }

  // ---------- Entrega a autoridades (doble aprobación) ----------

  async requestDisclosure(operatorId: string, tripId: string, incidentId: string | null, authority: string, legalBasis: string, req: AppRequest) {
    const trip = await this.pool.query('SELECT 1 FROM trips.trips WHERE id = $1', [tripId]);
    if (!trip.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO safety.authority_disclosures (id, incident_id, trip_id, authority, legal_basis, requested_by, status) VALUES ($1, $2, $3, $4, $5, $6, 'pending_approval')`,
      [id, incidentId, tripId, authority, legalBasis, operatorId],
    );
    await this.audit.record({ action: 'authority.disclosure_requested', resourceType: 'trip', resourceId: tripId, actorUserId: operatorId, metadata: { disclosureId: id, authority, legalBasis } }, req);
    return { disclosureId: id, status: 'pending_approval' };
  }

  /** La aprueba OTRA persona (DPO o super_admin). El enlace se muestra una sola vez. */
  async approveDisclosure(approverId: string, disclosureId: string, req: AppRequest) {
    const token = randomToken(32);
    const r = await this.pool.query<{ trip_id: string; incident_id: string | null; authority: string }>(
      `UPDATE safety.authority_disclosures SET status = 'active', approved_by = $2, approved_at = now(), token_hash = $3, expires_at = now() + make_interval(hours => $4)
       WHERE id = $1 AND status = 'pending_approval' AND requested_by <> $2 RETURNING trip_id, incident_id, authority`,
      [disclosureId, approverId, sha256(token), this.config.AUTHORITY_LINK_HOURS],
    );
    if (!r.rows[0]) throw new AppError(409, 'cannot_approve', 'No existe, ya fue decidida o la solicitaste tú (se requiere otra persona)');
    await this.pool.query('UPDATE trips.trips SET incident_hold = true WHERE id = $1', [r.rows[0].trip_id]);
    await this.manifests.snapshot(r.rows[0].trip_id, 'authority_request');
    await this.audit.record({ action: 'authority.disclosure_approved', resourceType: 'trip', resourceId: r.rows[0].trip_id, actorUserId: approverId, metadata: { disclosureId } }, req);
    return { disclosureId, url: `${this.config.PUBLIC_BASE_URL}/v1/authority/manifest/${token}`, expiresInHours: this.config.AUTHORITY_LINK_HOURS, maxViews: 5 };
  }

  /** Vista para la autoridad: cuenta accesos, caduca y lleva marca de agua con la base legal. */
  async authorityView(token: string, req: AppRequest) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    const r = await this.pool.query(
      `UPDATE safety.authority_disclosures SET views = views + 1 WHERE token_hash = $1 AND status = 'active' AND expires_at > now() AND views < max_views
       RETURNING id, trip_id, authority, legal_basis, views, max_views, expires_at`,
      [sha256(token)],
    );
    const d = r.rows[0];
    if (!d) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    await this.audit.record({ action: 'authority.manifest_view', resourceType: 'trip', resourceId: d.trip_id, actorRole: 'authority', purpose: 'legal_disclosure', metadata: { disclosureId: d.id, view: d.views } }, req);
    const m = await this.manifests.latest(d.trip_id);
    return {
      watermark: `CONFIDENCIAL — Entregado a ${d.authority} bajo ${d.legal_basis}. Entrega ${d.id}, acceso ${d.views}/${d.max_views}, ${new Date().toISOString()}. Prohibida su difusión.`,
      expiresAt: d.expires_at,
      signature: m ? { algorithm: 'ES256', keyId: m.keyId, chainHash: m.chainHash, signature: m.signature, integrity: m.integrity, publicKeyPem: this.manifests.publicKeyPem() } : null,
      manifest: m?.payload ?? null,
    };
  }
}
