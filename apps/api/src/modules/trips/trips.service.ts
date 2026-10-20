import { Inject, Injectable } from '@nestjs/common';
import { constantTimeEqual, randomToken, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { canTransition, fareBreakdown, GUAYAQUIL_BBOX, inBBox, isValidLatLng, onDemandFareCents, surgeMultiplier, type LatLng, type TripStatus } from '@intitaxi/domain';
import { AppError, AuditService, internalFetch, OneTimeStore, RateLimiter, REDIS, tooManyRequests, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { MapsPort } from '../../infra/maps.js';
import { CONFIG, FIELD_CIPHER, MAPS, PG_POOL } from '../../tokens.js';
import { CommissionService } from '../payments/commission.service.js';
import { MatchingService } from './matching.service.js';
import { PresenceService } from './presence.service.js';
import { TripEvents } from './trip-events.js';

export interface TripRow {
  id: string;
  type: string;
  requester_user_id: string;
  driver_id: string | null;
  vehicle_id: string | null;
  status: TripStatus;
  origin_lat: string;
  origin_lng: string;
  origin_label_enc: Buffer | null;
  dest_lat: string;
  dest_lng: string;
  dest_label_enc: Buffer | null;
  distance_m: number;
  duration_s: number;
  quoted_fare_cents: number;
  final_fare_cents: number | null;
  base_fare_cents: number | null;
  surge_cents: number;
  currency: string;
  party_size: number;
  payment_method: string;
  payment_method_id: string | null;
  pin_enc: Buffer;
  pin_attempts: number;
  is_for_third_party: boolean;
  incident_hold: boolean;
  requested_at: Date;
  accepted_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  cancelled_by: string | null;
}

export interface Quote {
  userId: string;
  origin: LatLng;
  destination: LatLng;
  originLabel?: string;
  destinationLabel?: string;
  fareCents: number;
  /** Desglose (tarifa dinámica): base + recargo = fareCents. */
  baseCents?: number;
  surgeCents?: number;
  surgeMultiplier?: number;
  distanceM: number;
  durationS: number;
}

export const tripAad = {
  origin: (id: string) => `trips.trips.origin_label:${id}`,
  dest: (id: string) => `trips.trips.dest_label:${id}`,
  pin: (id: string) => `trips.trips.pin:${id}`,
};
const MAX_PIN_ATTEMPTS = 3;

/** Hooks que otros módulos registran (acompañantes, pagos…) sin acoplar el núcleo de viajes. */
export interface TripRequestHooks {
  /** Dentro de la transacción de creación. Devuelve el tamaño final del grupo. */
  beforeCreate?(c: PoolClient, trip: { id: string; requesterUserId: string; deviceId: string }, input: Record<string, unknown>, req: AppRequest): Promise<{ partySize?: number; isForThirdParty?: boolean } | void>;
}

@Injectable()
export class TripsService {
  readonly hooks: TripRequestHooks[] = [];
  /** Otros módulos pueden reconocer participantes adicionales (p. ej. pasajeros registrados con cuenta). */
  readonly participantResolvers: ((userId: string, trip: TripRow) => Promise<'passenger' | null>)[] = [];

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAPS) private readonly maps: MapsPort,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(MatchingService) private readonly matching: MatchingService,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CommissionService) private readonly commissions: CommissionService,
  ) {}

  #assertServiceArea(...pts: LatLng[]) {
    for (const p of pts) {
      if (!isValidLatLng(p) || !inBBox(p, GUAYAQUIL_BBOX)) throw new AppError(422, 'outside_service_area', 'Por ahora solo operamos en Guayaquil');
    }
  }

  /** Cotización con precio cerrado, guardada en el servidor 5 min: el cliente nunca envía el precio. */
  async quote(userId: string, input: { origin: LatLng; destination: LatLng; originLabel?: string; destinationLabel?: string }) {
    this.#assertServiceArea(input.origin, input.destination);
    const rl = await this.limiter.hit(`quote:${userId}`, 30, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const route = await this.maps.route(input.origin, input.destination);
    const baseCents = onDemandFareCents(route.distanceM, route.durationS, {
      baseCents: this.config.FARE_BASE_CENTS, perKmCents: this.config.FARE_PER_KM_CENTS, perMinuteCents: this.config.FARE_PER_MIN_CENTS, minimumCents: this.config.FARE_MIN_CENTS,
    });
    const surge = this.config.SURGE_ENABLED ? surgeMultiplier(await this.#demandSupply(input.origin), this.config.SURGE_MAX) : { multiplier: 1, reason: 'normal' as const };
    const b = fareBreakdown(baseCents, surge.multiplier, await this.commissions.settings().then((x) => x.on_demand_bps));
    const quoteId = randomToken(18);
    const q: Quote = { userId, ...input, fareCents: b.totalCents, baseCents, surgeCents: b.surgeCents, surgeMultiplier: surge.multiplier, distanceM: route.distanceM, durationS: route.durationS };
    await this.once.put(`quote:${quoteId}`, q, 300);
    return {
      quoteId,
      fareCents: b.totalCents,
      currency: 'USD',
      distanceM: route.distanceM,
      durationS: route.durationS,
      expiresIn: 300,
      // Transparencia: el pasajero ve el desglose y que el recargo es para el conductor.
      breakdown: { baseCents, surgeCents: b.surgeCents, multiplier: surge.multiplier, reason: surge.reason, driverEarnsCents: b.driverEarnsCents, priceLocked: true },
    };
  }

  /** Pedidos sin conductor y conductores libres en ~3 km del origen (para la tarifa dinámica). */
  async #demandSupply(origin: LatLng) {
    const d = 0.027; // ≈ 3 km en Guayaquil
    const { rows } = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trips.trips WHERE status IN ('matching', 'no_drivers') AND requested_at > now() - interval '10 minutes'
         AND origin_lat BETWEEN $1 AND $2 AND origin_lng BETWEEN $3 AND $4`,
      [origin.lat - d, origin.lat + d, origin.lng - d, origin.lng + d],
    );
    const supply = (await this.presence.nearby(origin, 3000, 50)).length;
    return { demand: rows[0]!.n, supply };
  }

  async request(userId: string, device: AttestedDevice, input: { quoteId: string; paymentMethod: 'cash' | 'card' | 'wallet'; idempotencyKey: string } & Record<string, unknown>, req: AppRequest) {
    const idemKey = `idem:trip:${userId}:${input.idempotencyKey}`;
    const prior = await this.redis.get(idemKey);
    if (prior) return this.viewFor(userId, prior);
    const rl = await this.limiter.hit(`trip-request:${userId}`, 6, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    // Decisión aprobada: un teléfono rooteado puede viajar, pero no pagar con tarjeta ni billetera.
    if (input.paymentMethod !== 'cash' && device.flags.includes('device_integrity_basic_only')) {
      throw new AppError(403, 'payment_method_not_allowed', 'En este dispositivo solo está disponible el pago en efectivo');
    }
    const quote = await this.once.take<Quote>(`quote:${input.quoteId}`);
    if (!quote || quote.userId !== userId) throw new AppError(409, 'quote_expired', 'La cotización venció; vuelve a cotizar');

    const id = randomUUID();
    const pin = randomInt(0, 10_000).toString().padStart(4, '0');
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO trips.trips (id, requester_user_id, status, origin_lat, origin_lng, origin_label_enc, dest_lat, dest_lng, dest_label_enc,
           distance_m, duration_s, quoted_fare_cents, payment_method, payment_method_id, pin_enc, search_radius_m, base_fare_cents, surge_cents, surge_multiplier)
         VALUES ($1, $2, 'matching', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          id, userId, quote.origin.lat, quote.origin.lng, quote.originLabel ? await this.cipher.encrypt(quote.originLabel, tripAad.origin(id)) : null,
          quote.destination.lat, quote.destination.lng, quote.destinationLabel ? await this.cipher.encrypt(quote.destinationLabel, tripAad.dest(id)) : null,
          quote.distanceM, quote.durationS, quote.fareCents, input.paymentMethod, (input.paymentMethodId as string) ?? null,
          await this.cipher.encrypt(pin, tripAad.pin(id)), this.config.MATCHING_RADIUS_M, quote.baseCents ?? quote.fareCents, quote.surgeCents ?? 0, quote.surgeMultiplier ?? 1,
        ],
      ).catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'active_trip_exists', 'Ya tienes un viaje en curso') : e;
      });
      for (const h of this.hooks) {
        const r = await h.beforeCreate?.(c, { id, requesterUserId: userId, deviceId: device.deviceId }, input, req);
        if (r?.partySize) await c.query('UPDATE trips.trips SET party_size = $2 WHERE id = $1', [id, r.partySize]);
        if (r?.isForThirdParty) await c.query('UPDATE trips.trips SET is_for_third_party = true WHERE id = $1', [id]);
      }
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id) VALUES ($1, 'requested', 'requester', $2)`, [id, userId]);
      await this.audit.record({ action: 'trip.request', resourceType: 'trip', resourceId: id, metadata: { payment: input.paymentMethod } }, req, c);
    });
    await this.redis.set(idemKey, id, 'EX', 86400);
    this.events.emitStatus({ tripId: id, from: null, to: 'matching', requesterUserId: userId, driverId: null });
    await this.matching.dispatch(id);
    return this.viewFor(userId, id);
  }

  async load(tripId: string, c: Pool | PoolClient = this.pool): Promise<TripRow | null> {
    const { rows } = await c.query<TripRow>('SELECT * FROM trips.trips WHERE id = $1', [tripId]);
    return rows[0] ?? null;
  }

  /** Autorización a nivel de objeto: solo el solicitante, el conductor asignado o los pasajeros registrados. */
  async participantRole(userId: string, trip: TripRow): Promise<'requester' | 'driver' | 'passenger' | null> {
    if (trip.requester_user_id === userId) return 'requester';
    if (trip.driver_id === userId) return 'driver';
    for (const resolve of this.participantResolvers) {
      const r = await resolve(userId, trip);
      if (r) return r;
    }
    return null;
  }

  async viewFor(userId: string, tripId: string) {
    const t = await this.load(tripId);
    const role = t ? await this.participantRole(userId, t) : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const driver = t.driver_id ? await this.driverCard(t.driver_id, t.vehicle_id) : null;
    const loc = t.driver_id && ['accepted', 'arrived', 'in_progress'].includes(t.status) ? await this.presence.lastLocation(t.driver_id) : null;
    return {
      id: t.id,
      type: t.type,
      status: t.status,
      role,
      origin: { lat: Number(t.origin_lat), lng: Number(t.origin_lng), label: t.origin_label_enc ? await this.cipher.decrypt(t.origin_label_enc, tripAad.origin(t.id)) : null },
      destination: { lat: Number(t.dest_lat), lng: Number(t.dest_lng), label: t.dest_label_enc ? await this.cipher.decrypt(t.dest_label_enc, tripAad.dest(t.id)) : null },
      fare: { quotedCents: t.quoted_fare_cents, finalCents: t.final_fare_cents, currency: t.currency, baseCents: t.base_fare_cents ?? t.quoted_fare_cents, surgeCents: t.surge_cents ?? 0 },
      distanceM: t.distance_m,
      partySize: t.party_size,
      paymentMethod: t.payment_method,
      driver,
      driverLocation: loc ? { lat: loc.lat, lng: loc.lng, at: loc.at } : null,
      times: { requestedAt: t.requested_at, acceptedAt: t.accepted_at, arrivedAt: t.arrived_at, startedAt: t.started_at, endedAt: t.ended_at },
    };
  }

  /** Lo que el pasajero ve del conductor: nombre de pila verificado, vehículo, placa y calificación. */
  async driverCard(driverId: string, vehicleId: string | null) {
    const v = vehicleId ? (await this.pool.query('SELECT plate, make, model, color FROM drivers.vehicles WHERE id = $1', [vehicleId])).rows[0] : null;
    const r = (await this.pool.query<{ avg: string | null; n: string }>('SELECT avg(stars) AS avg, count(*) AS n FROM trips.ratings WHERE ratee_user_id = $1', [driverId])).rows[0]!;
    const k = await this.pool.query<{ id: string; given_names_enc: Buffer | null }>(
      `SELECT id, given_names_enc FROM kyc.verifications WHERE user_id = $1 AND kind = 'full' AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`,
      [driverId],
    );
    const given = k.rows[0]?.given_names_enc ? await this.cipher.decrypt(k.rows[0].given_names_enc, `kyc.verifications.given_names:${k.rows[0].id}`) : null;
    return {
      firstName: given?.split(' ')[0] ?? 'Conductor',
      identityVerified: !!k.rows[0],
      vehicle: v ? { plate: v.plate, make: v.make, model: v.model, color: v.color } : null,
      rating: r.avg ? Math.round(Number(r.avg) * 10) / 10 : null,
      ratingsCount: Number(r.n),
    };
  }

  /** Tarjeta del conductor para el seguimiento (sin calificaciones detalladas). */
  async driverCardForTracking(driverId: string, tripId: string) {
    const t = await this.load(tripId);
    const c = await this.driverCard(driverId, t?.vehicle_id ?? null);
    return { firstName: c.firstName, vehicle: c.vehicle, identityVerified: c.identityVerified };
  }

  async pin(userId: string, tripId: string) {
    const t = await this.load(tripId);
    if (!t || t.requester_user_id !== userId) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return { pin: await this.cipher.decrypt(t.pin_enc, tripAad.pin(t.id)) };
  }

  async history(userId: string, asDriver: boolean) {
    const { rows } = await this.pool.query(
      `SELECT id, status, quoted_fare_cents AS "fareCents", final_fare_cents AS "finalFareCents", requested_at AS "requestedAt", ended_at AS "endedAt"
       FROM trips.trips WHERE ${asDriver ? 'driver_id' : 'requester_user_id'} = $1 ORDER BY requested_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  }

  /** Transición protegida por la máquina de estados y por el rol del actor. */
  async #transition(tripId: string, actor: { userId: string; role: 'requester' | 'driver' }, to: TripStatus, extra: (c: PoolClient, t: TripRow) => Promise<void> | void, req: AppRequest) {
    const t = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<TripRow>('SELECT * FROM trips.trips WHERE id = $1 FOR UPDATE', [tripId]);
      const trip = rows[0];
      const owns = trip && (actor.role === 'requester' ? trip.requester_user_id === actor.userId : trip.driver_id === actor.userId);
      if (!trip || !owns) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (!canTransition(trip.status, to)) throw new AppError(409, 'invalid_state', `No se puede pasar de ${trip.status} a ${to}`);
      await extra(c, trip);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id) VALUES ($1, $2, $3, $4)`, [tripId, to, actor.role, actor.userId]);
      await this.audit.record({ action: `trip.${to}`, resourceType: 'trip', resourceId: tripId }, req, c);
      return trip;
    });
    this.events.emitStatus({ tripId, from: t.status, to, requesterUserId: t.requester_user_id, driverId: t.driver_id });
    return t;
  }

  async cancel(userId: string, tripId: string, reason: string | undefined, req: AppRequest) {
    const t = await this.load(tripId);
    const role = t?.requester_user_id === userId ? 'requester' : t?.driver_id === userId ? 'driver' : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.#transition(tripId, { userId, role }, 'cancelled', async (c) => {
      await c.query(`UPDATE trips.trips SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, ended_at = now() WHERE id = $1`, [tripId, role, reason ?? null]);
      await c.query(`UPDATE trips.offers SET status = 'superseded' WHERE trip_id = $1 AND status = 'pending'`, [tripId]);
    }, req);
    if (t.driver_id) await this.presence.setTrip(t.driver_id, null);
    return { tripId, status: 'cancelled' };
  }

  async arrived(driverId: string, tripId: string, req: AppRequest) {
    await this.#transition(tripId, { userId: driverId, role: 'driver' }, 'arrived', (c) => c.query(`UPDATE trips.trips SET status = 'arrived', arrived_at = now() WHERE id = $1`, [tripId]).then(() => undefined), req);
    return { tripId, status: 'arrived' };
  }

  /** El conductor introduce el PIN que le dice el pasajero: confirma que sube a la persona correcta y al taxi correcto. */
  async start(driverId: string, tripId: string, pin: string, req: AppRequest) {
    const t = await this.load(tripId);
    if (!t || t.driver_id !== driverId) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (t.pin_attempts >= MAX_PIN_ATTEMPTS) throw new AppError(423, 'pin_locked', 'Demasiados intentos de PIN: contacta a soporte');
    const real = await this.cipher.decrypt(t.pin_enc, tripAad.pin(t.id));
    if (!/^\d{4}$/.test(pin) || !constantTimeEqual(Buffer.from(pin), Buffer.from(real))) {
      await this.pool.query('UPDATE trips.trips SET pin_attempts = pin_attempts + 1 WHERE id = $1', [tripId]);
      await this.pool.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id) VALUES ($1, 'pin_failed', 'driver', $2)`, [tripId, driverId]);
      await this.audit.record({ action: 'trip.pin_failed', resourceType: 'trip', resourceId: tripId, outcome: 'denied' }, req);
      throw new AppError(400, 'invalid_pin', 'PIN incorrecto');
    }
    await this.#transition(tripId, { userId: driverId, role: 'driver' }, 'in_progress', (c) => c.query(`UPDATE trips.trips SET status = 'in_progress', started_at = now() WHERE id = $1`, [tripId]).then(() => undefined), req);
    return { tripId, status: 'in_progress' };
  }

  async complete(driverId: string, tripId: string, req: AppRequest) {
    await this.#transition(tripId, { userId: driverId, role: 'driver' }, 'completed', (c, t) =>
      // Precio cerrado: se cobra lo cotizado (los ajustes por desvíos se gestionan como disputa).
      c.query(`UPDATE trips.trips SET status = 'completed', ended_at = now(), final_fare_cents = $2 WHERE id = $1`, [tripId, t.quoted_fare_cents]).then(() => undefined), req);
    await this.presence.setTrip(driverId, null);
    return { tripId, status: 'completed' };
  }

  async rate(userId: string, tripId: string, stars: number, comment: string | undefined, req: AppRequest) {
    const t = await this.load(tripId);
    const role = t?.requester_user_id === userId ? 'requester' : t?.driver_id === userId ? 'driver' : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (t.status !== 'completed' || !t.ended_at || Date.now() - t.ended_at.getTime() > 7 * 86400_000) throw new AppError(409, 'not_rateable', 'Solo se califican viajes completados en los últimos 7 días');
    const ratee = role === 'requester' ? t.driver_id! : t.requester_user_id;
    await this.pool.query(
      'INSERT INTO trips.ratings (trip_id, rater_user_id, ratee_user_id, stars, comment_enc) VALUES ($1, $2, $3, $4, $5)',
      [tripId, userId, ratee, stars, comment ? await this.cipher.encrypt(comment, `trips.ratings.comment:${tripId}:${userId}`) : null],
    ).catch((e: { code?: string }) => {
      throw e.code === '23505' ? new AppError(409, 'already_rated', 'Ya calificaste este viaje') : e;
    });
    await this.audit.record({ action: 'trip.rate', resourceType: 'trip', resourceId: tripId, metadata: { stars } }, req);
    return { tripId, stars };
  }

  /** Llamada enmascarada: auth (que custodia los teléfonos) crea el número proxy; la API nunca ve los números. */
  async contactSession(userId: string, tripId: string, req: AppRequest) {
    const t = await this.load(tripId);
    const role = t ? await this.participantRole(userId, t) : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (!t.driver_id || !['accepted', 'arrived', 'in_progress'].includes(t.status)) throw new AppError(409, 'not_available', 'Solo durante un viaje activo');
    const r = await internalFetch(Buffer.from(this.config.INTERNAL_SIGNING_SECRET, 'base64'), 'api', this.config.INTERNAL_AUTH_URL, 'POST', '/internal/v1/contact-sessions', {
      sessionKey: tripId, participants: [t.requester_user_id, t.driver_id], ttlSeconds: 3600,
    });
    if (r.status !== 201) throw new AppError(502, 'contact_unavailable', 'No se pudo crear la llamada enmascarada');
    await this.audit.record({ action: 'trip.contact_session', resourceType: 'trip', resourceId: tripId }, req);
    return r.body;
  }
}
