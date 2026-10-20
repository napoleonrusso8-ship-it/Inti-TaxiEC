import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { haversineMeters, localParts, type LatLng } from '@intitaxi/domain';
import { AppError, AuditService, internalFetch, REDIS, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { CONFIG, PG_POOL } from '../../tokens.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PresenceService } from '../trips/presence.service.js';

const STILL_RADIUS_M = 40;
const NEAR_DESTINATION_M = 300;
const RECHECK_COOLDOWN_S = 600;

/**
 * Alerta de desvío y de parada inesperada (función de seguridad).
 * Durante un viaje en curso se vigila la ubicación del vehículo: si se aleja del destino respecto a lo
 * más cerca que estuvo, o se detiene mucho tiempo lejos del destino, se pregunta al PASAJERO
 * (no al conductor) si está bien. Sin respuesta a tiempo, o si pide ayuda, se escala como SOS.
 * Por defecto activa de noche (21:00–06:00, hora de Guayaquil); el pasajero puede activarla siempre o desactivarla.
 */
@Injectable()
export class SafetyMonitorService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('SafetyMonitor');
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    const previous = this.presence.onTripLocation;
    this.presence.onTripLocation = async (tripId, loc) => {
      await previous?.(tripId, loc);
      if (/^[0-9a-f-]{36}$/.test(tripId)) await this.observe(tripId, loc).catch((e) => this.#log.error(e.message));
    };
    this.#timer = setInterval(() => void this.escalateOverdue().catch((e) => this.#log.error(e.message)), this.config.SAFETY_SWEEP_MS);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  async observe(tripId: string, loc: LatLng & { at: number }) {
    const key = `safety:trip:${tripId}`;
    let st = await this.redis.hgetall(key);
    if (!st.enabled) {
      const t = (await this.pool.query(
        `SELECT t.status, t.type, t.dest_lat::float8 AS dlat, t.dest_lng::float8 AS dlng, t.started_at, coalesce(p.deviation_alerts, 'night') AS pref
         FROM trips.trips t LEFT JOIN people.passenger_profiles p ON p.user_id = t.requester_user_id WHERE t.id = $1`,
        [tripId],
      )).rows[0];
      if (!t || t.status !== 'in_progress' || t.type !== 'on_demand') return;
      const hour = Number(localParts(t.started_at ?? new Date()).time.slice(0, 2));
      const enabled = t.pref === 'always' || (t.pref === 'night' && (hour >= 21 || hour < 6));
      st = { enabled: enabled ? '1' : '0', dlat: String(t.dlat), dlng: String(t.dlng), startedAt: String(new Date(t.started_at ?? Date.now()).getTime()), minDist: '', stillLat: String(loc.lat), stillLng: String(loc.lng), stillSince: String(loc.at), lastCheckAt: '0' };
      await this.redis.multi().hset(key, st).expire(key, 6 * 3600).exec();
    }
    if (st.enabled !== '1') return;
    const dest = { lat: Number(st.dlat), lng: Number(st.dlng) };
    const dist = haversineMeters(loc, dest);
    const minDist = st.minDist ? Math.min(Number(st.minDist), dist) : dist;
    const updates: Record<string, string> = { minDist: String(minDist) };
    let trigger: { kind: 'deviation' | 'long_stop'; data: Record<string, number> } | null = null;
    const elapsed = (loc.at - Number(st.startedAt)) / 1000;
    if (elapsed >= this.config.DEVIATION_MIN_TRIP_SECONDS && dist > minDist + this.config.DEVIATION_THRESHOLD_M) {
      trigger = { kind: 'deviation', data: { distanceToDestinationM: Math.round(dist), closestM: Math.round(minDist) } };
    }
    if (haversineMeters(loc, { lat: Number(st.stillLat), lng: Number(st.stillLng) }) > STILL_RADIUS_M) {
      Object.assign(updates, { stillLat: String(loc.lat), stillLng: String(loc.lng), stillSince: String(loc.at) });
    } else if (!trigger && dist > NEAR_DESTINATION_M && (loc.at - Number(st.stillSince)) / 1000 >= this.config.LONG_STOP_SECONDS) {
      trigger = { kind: 'long_stop', data: { stoppedSeconds: Math.round((loc.at - Number(st.stillSince)) / 1000) } };
    }
    if (trigger && Date.now() / 1000 - Number(st.lastCheckAt) > RECHECK_COOLDOWN_S) {
      updates.lastCheckAt = String(Math.floor(Date.now() / 1000));
      await this.#openCheck(tripId, trigger.kind, trigger.data);
    }
    await this.redis.hset(key, updates);
  }

  async #openCheck(tripId: string, kind: 'deviation' | 'long_stop', data: Record<string, number>) {
    const id = randomUUID();
    const t = (await this.pool.query(`SELECT requester_user_id FROM trips.trips WHERE id = $1`, [tripId])).rows[0];
    await this.pool.query(
      `INSERT INTO trips.safety_checks (id, trip_id, kind, status, data, respond_by) VALUES ($1, $2, $3, 'pending', $4, now() + make_interval(secs => $5))`,
      [id, tripId, kind, data, this.config.SAFETY_CHECK_RESPONSE_SECONDS],
    );
    await this.audit.record({ action: `safety.check_${kind}`, resourceType: 'trip', resourceId: tripId, actorRole: 'system', metadata: data });
    // Solo al pasajero (el conductor no debe enterarse si el problema es él).
    await this.notify.notifyUser(t.requester_user_id, 'safety_check', { sms: 'Inti Taxi: notamos un cambio inusual en tu ruta. ¿Estás bien? Responde en la app; si no respondes, activaremos la ayuda.' });
  }

  /** Comprobación pendiente del pasajero (la app la consulta durante el viaje). */
  async pending(userId: string, tripId: string) {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.kind, c.respond_by AS "respondBy" FROM trips.safety_checks c JOIN trips.trips t ON t.id = c.trip_id
       WHERE c.trip_id = $1 AND t.requester_user_id = $2 AND c.status = 'pending' ORDER BY c.created_at DESC LIMIT 1`,
      [tripId, userId],
    );
    return rows[0] ?? null;
  }

  async respond(userId: string, tripId: string, checkId: string, ok: boolean, req: AppRequest) {
    const u = await this.pool.query(
      `UPDATE trips.safety_checks c SET status = $4, responded_at = now() FROM trips.trips t
       WHERE c.id = $1 AND c.trip_id = $2 AND t.id = c.trip_id AND t.requester_user_id = $3 AND c.status = 'pending' RETURNING c.id`,
      [checkId, tripId, userId, ok ? 'ok' : 'help'],
    );
    if (!u.rowCount) throw new AppError(404, 'not_found', 'No hay una comprobación pendiente');
    await this.audit.record({ action: ok ? 'safety.check_ok' : 'safety.check_help', resourceType: 'trip', resourceId: tripId }, req);
    if (!ok) await this.#escalate(tripId, checkId, 'help_requested');
    return { status: ok ? 'ok' : 'help' };
  }

  async escalateOverdue() {
    const { rows } = await this.pool.query<{ id: string; trip_id: string }>(
      `UPDATE trips.safety_checks SET status = 'escalated' WHERE id IN (SELECT id FROM trips.safety_checks WHERE status = 'pending' AND respond_by < now() FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING id, trip_id`,
    );
    for (const r of rows) await this.#escalate(r.trip_id, r.id, 'no_response');
    return rows.length;
  }

  /** Abre el incidente en el servicio SOS (aislado), con la última ubicación del vehículo. */
  async #escalate(tripId: string, checkId: string, reason: 'no_response' | 'help_requested') {
    const r = await internalFetch(Buffer.from(this.config.INTERNAL_SIGNING_SECRET, 'base64'), 'api', this.config.SOS_INTERNAL_URL, 'POST', '/internal/v1/safety-escalations', { tripId, checkId, reason });
    if (r.status !== 201) this.#log.error(`no se pudo escalar ${checkId}: ${r.status}`);
    await this.pool.query(`UPDATE trips.safety_checks SET status = 'escalated' WHERE id = $1 AND status IN ('pending', 'help')`, [checkId]);
  }
}
