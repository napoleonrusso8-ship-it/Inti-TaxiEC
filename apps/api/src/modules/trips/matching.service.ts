import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { withTransaction, type Pool } from '@intitaxi/db';
import { AppError, AuditService, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { CONFIG, PG_POOL } from '../../tokens.js';
import { PresenceService } from './presence.service.js';
import { TripEvents } from './trip-events.js';

interface MatchingTrip {
  id: string;
  requester_user_id: string;
  origin_lat: string;
  origin_lng: string;
  party_size: number;
  search_radius_m: number;
  requested_at: Date;
}

/**
 * Emparejamiento secuencial: se ofrece el viaje al conductor disponible más cercano durante N segundos;
 * si rechaza o no responde, al siguiente. Si no hay nadie, se amplía el radio y, tras 60 s, "sin conductores".
 * Postgres es la fuente de verdad (bloqueos de fila); Redis solo da la cercanía.
 */
@Injectable()
export class MatchingService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('Matching');
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.#timer = setInterval(() => void this.sweep().catch((e) => this.#log.error(e.message)), this.config.MATCHING_SWEEP_MS);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  /** Busca el siguiente candidato para un viaje en "matching" sin oferta vigente. */
  async dispatch(tripId: string): Promise<'offered' | 'waiting' | 'no_drivers' | 'skip'> {
    const result = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<MatchingTrip>(`SELECT * FROM trips.trips WHERE id = $1 AND status = 'matching' FOR UPDATE SKIP LOCKED`, [tripId]);
      const trip = rows[0];
      if (!trip) return { kind: 'skip' as const };
      const pending = await c.query(`SELECT 1 FROM trips.offers WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
      if (pending.rowCount) return { kind: 'skip' as const };
      const tried = new Set((await c.query<{ driver_id: string }>('SELECT driver_id FROM trips.offers WHERE trip_id = $1', [tripId])).rows.map((r) => r.driver_id));
      const origin = { lat: Number(trip.origin_lat), lng: Number(trip.origin_lng) };
      for (const cand of await this.presence.nearby(origin, trip.search_radius_m)) {
        if (tried.has(cand.driverId) || cand.driverId === trip.requester_user_id) continue;
        const st = await this.presence.state(cand.driverId);
        // Solo los taxis reciben viajes bajo demanda (furgonetas: Taxi Ruta; grúas: asistencia).
        if (!st || st.tripId || st.vehicleType !== 'taxi' || st.seats < trip.party_size) continue;
        const offerId = randomUUID();
        await c.query(
          `INSERT INTO trips.offers (id, trip_id, driver_id, status, distance_m, expires_at) VALUES ($1, $2, $3, 'pending', $4, now() + make_interval(secs => $5))`,
          [offerId, tripId, cand.driverId, cand.distanceM, this.config.MATCHING_OFFER_TTL_SECONDS],
        );
        await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, data) VALUES ($1, 'offer_sent', 'system', $2)`, [tripId, { driverDistanceM: cand.distanceM }]);
        return { kind: 'offered' as const, driverId: cand.driverId, offerId };
      }
      if (trip.search_radius_m < this.config.MATCHING_MAX_RADIUS_M) {
        await c.query('UPDATE trips.trips SET search_radius_m = $2 WHERE id = $1', [tripId, this.config.MATCHING_MAX_RADIUS_M]);
        return { kind: 'retry' as const };
      }
      if (Date.now() - trip.requested_at.getTime() > 60_000) {
        await c.query(`UPDATE trips.trips SET status = 'no_drivers', ended_at = now() WHERE id = $1`, [tripId]);
        await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role) VALUES ($1, 'no_drivers', 'system')`, [tripId]);
        return { kind: 'no_drivers' as const, requester: trip.requester_user_id };
      }
      return { kind: 'waiting' as const };
    });
    if (result.kind === 'retry') return this.dispatch(tripId);
    if (result.kind === 'offered') this.events.emit('offer.created', { tripId, driverId: result.driverId, offerId: result.offerId });
    if (result.kind === 'no_drivers') this.events.emitStatus({ tripId, from: 'matching', to: 'no_drivers', requesterUserId: result.requester, driverId: null });
    return result.kind;
  }

  /** Vence ofertas sin respuesta y reintenta los viajes en búsqueda. Seguro con varias instancias (SKIP LOCKED). */
  async sweep() {
    const expired = await this.pool.query<{ trip_id: string }>(
      `UPDATE trips.offers SET status = 'expired', responded_at = now()
       WHERE id IN (SELECT id FROM trips.offers WHERE status = 'pending' AND expires_at < now() FOR UPDATE SKIP LOCKED)
       RETURNING trip_id`,
    );
    const matching = await this.pool.query<{ id: string }>(`SELECT id FROM trips.trips WHERE status = 'matching' LIMIT 200`);
    const ids = new Set([...expired.rows.map((r) => r.trip_id), ...matching.rows.map((r) => r.id)]);
    for (const id of ids) await this.dispatch(id);
  }

  async offersFor(driverId: string) {
    const { rows } = await this.pool.query(
      `SELECT o.id AS "offerId", o.trip_id AS "tripId", o.expires_at AS "expiresAt", o.distance_m AS "pickupDistanceM",
              t.origin_lat AS "originLat", t.origin_lng AS "originLng", t.dest_lat AS "destLat", t.dest_lng AS "destLng",
              t.quoted_fare_cents AS "fareCents", t.surge_cents AS "surgeCents", t.distance_m AS "tripDistanceM", t.party_size AS "partySize", t.payment_method AS "paymentMethod",
              -- Reputación del pasajero visible antes de aceptar.
              (SELECT round(avg(stars), 1)::float8 FROM trips.ratings r WHERE r.ratee_user_id = t.requester_user_id) AS "passengerRating",
              (SELECT count(*)::int FROM trips.trips x WHERE x.requester_user_id = t.requester_user_id AND x.status = 'completed') AS "passengerTrips"
       FROM trips.offers o JOIN trips.trips t ON t.id = o.trip_id
       WHERE o.driver_id = $1 AND o.status = 'pending' AND o.expires_at > now()`,
      [driverId],
    );
    return rows;
  }

  async accept(driverId: string, offerId: string, req: AppRequest) {
    const st = await this.presence.state(driverId);
    if (!st || st.tripId) throw new AppError(409, 'driver_unavailable', 'Debes estar conectado y libre');
    const out = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ trip_id: string; status: string; expired: boolean }>(
        `SELECT trip_id, status, expires_at < now() AS expired FROM trips.offers WHERE id = $1 AND driver_id = $2 FOR UPDATE`,
        [offerId, driverId],
      );
      const offer = rows[0];
      // Oferta ajena o inexistente → 404 (anti-IDOR); vencida o ya respondida → 409.
      if (!offer) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (offer.status !== 'pending' || offer.expired) throw new AppError(409, 'offer_unavailable', 'La oferta ya no está disponible');
      const t = await c.query<{ requester_user_id: string }>(
        `UPDATE trips.trips SET status = 'accepted', driver_id = $2, vehicle_id = $3, accepted_at = now() WHERE id = $1 AND status = 'matching' RETURNING requester_user_id`,
        [offer.trip_id, driverId, st.vehicleId],
      ).catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'driver_busy', 'Ya tienes un viaje activo') : e;
      });
      if (!t.rowCount) throw new AppError(409, 'offer_unavailable', 'El viaje ya no está disponible');
      await c.query(`UPDATE trips.offers SET status = 'accepted', responded_at = now() WHERE id = $1`, [offerId]);
      await c.query(`UPDATE trips.offers SET status = 'superseded' WHERE trip_id = $1 AND id <> $2 AND status = 'pending'`, [offer.trip_id, offerId]);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id) VALUES ($1, 'accepted', 'driver', $2)`, [offer.trip_id, driverId]);
      await this.audit.record({ action: 'trip.accept', resourceType: 'trip', resourceId: offer.trip_id }, req, c);
      return { tripId: offer.trip_id, requester: t.rows[0]!.requester_user_id };
    });
    await this.presence.setTrip(driverId, out.tripId);
    this.events.emitStatus({ tripId: out.tripId, from: 'matching', to: 'accepted', requesterUserId: out.requester, driverId });
    return { tripId: out.tripId, status: 'accepted' };
  }

  async reject(driverId: string, offerId: string) {
    const r = await this.pool.query<{ trip_id: string }>(
      `UPDATE trips.offers SET status = 'rejected', responded_at = now() WHERE id = $1 AND driver_id = $2 AND status = 'pending' RETURNING trip_id`,
      [offerId, driverId],
    );
    if (!r.rows[0]) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.dispatch(r.rows[0].trip_id);
    return { offerId, status: 'rejected' };
  }
}
