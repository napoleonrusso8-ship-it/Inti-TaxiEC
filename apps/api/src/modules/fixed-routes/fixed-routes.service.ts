import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { constantTimeEqual, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool, type PoolClient } from '@intitaxi/db';
import { etaSeconds, fareAt, localParts, projectOnPath, type FareRule, type LatLng } from '@intitaxi/domain';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import { randomInt, randomUUID } from 'node:crypto';
import { CONFIG, FIELD_CIPHER, PG_POOL } from '../../tokens.js';
import type { AppConfig } from '../../config.js';
import { DriversService } from '../drivers/drivers.service.js';
import { KycService } from '../kyc/kyc.service.js';
import { PresenceService } from '../trips/presence.service.js';
import { CommissionService } from '../payments/commission.service.js';
import { SanctionsService } from '../trust/sanctions.service.js';
import { postLedger } from '../payments/ledger.js';
import { TripEvents } from '../trips/trip-events.js';
import { TripTrackingService } from '../trips/trip-tracking.service.js';
import { tripAad, TripsService } from '../trips/trips.service.js';

export interface StopView {
  id: string;
  name: string;
  reference: string | null;
  lat: number;
  lng: number;
  seq: number;
  locationVerified: boolean;
}

const BOOKING_TTL_MIN = 45;
export type VehicleType = 'taxi' | 'van';
export const VEHICLE_LABEL: Record<VehicleType, string> = { taxi: 'Taxi', van: 'Furgoneta' };
const MAX_PIN_ATTEMPTS = 3;
const MAX_SWITCH = 5;

@Injectable()
export class FixedRoutesService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('TaxiRuta');
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(TripTrackingService) private readonly tracking: TripTrackingService,
    @Inject(DriversService) private readonly drivers: DriversService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CommissionService) private readonly commissions: CommissionService,
    @Inject(SanctionsService) private readonly sanctions: SanctionsService,
  ) {}

  onModuleInit() {
    // La ubicación del conductor en servicio de ruta alimenta la ruta GPS de cada pasajero a bordo.
    const previous = this.presence.onTripLocation;
    this.presence.onTripLocation = async (tripId, loc) => {
      if (!tripId.startsWith('route:')) return previous?.(tripId, loc);
      const boarded = await this.pool.query<{ trip_id: string }>(`SELECT trip_id FROM fixed_routes.bookings WHERE instance_id = $1 AND status IN ('reserved', 'boarded')`, [tripId.slice(6)]);
      for (const b of boarded.rows) await this.tracking.record(b.trip_id, loc, 'driver');
    };
    this.#timer = setInterval(() => void this.expireBookings().catch((e) => this.#log.error(e.message)), 30_000);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  // ---------- Lectura (pasajeros) ----------

  /** Reglas tarifarias vigentes (no retiradas); con `vehicleType`, solo las de ese tipo de vehículo. */
  async rules(routeId: string, c: Pool | PoolClient = this.pool, vehicleType?: VehicleType): Promise<(FareRule & { vehicleType: VehicleType })[]> {
    const { rows } = await c.query(
      `SELECT id, name, to_char(start_local, 'HH24:MI:SS') AS s, to_char(end_local, 'HH24:MI:SS') AS e, amount_cents, to_char(valid_from, 'YYYY-MM-DD') AS vf, to_char(valid_to, 'YYYY-MM-DD') AS vt, priority, vehicle_type
       FROM fixed_routes.fare_rules WHERE route_id = $1 AND retired_at IS NULL AND ($2::text IS NULL OR vehicle_type = $2)`,
      [routeId, vehicleType ?? null],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, startLocal: r.s, endLocal: r.e, amountCents: r.amount_cents, validFrom: r.vf, validTo: r.vt, priority: r.priority, vehicleType: r.vehicle_type }));
  }

  async stops(directionId: string, c: Pool | PoolClient = this.pool): Promise<StopView[]> {
    const { rows } = await c.query(
      `SELECT s.id, s.name, s.reference, s.lat::float8 AS lat, s.lng::float8 AS lng, ds.seq, s.location_verified AS "locationVerified"
       FROM fixed_routes.direction_stops ds JOIN fixed_routes.stops s ON s.id = ds.stop_id WHERE ds.direction_id = $1 ORDER BY ds.seq`,
      [directionId],
    );
    return rows;
  }

  async #direction(routeId: string, direction: string, c: Pool | PoolClient = this.pool) {
    const { rows } = await c.query<{ id: string; label: string; path: LatLng[] | null; status: string }>(
      `SELECT d.id, d.label, d.path, r.status FROM fixed_routes.directions d JOIN fixed_routes.routes r ON r.id = d.route_id WHERE d.route_id = $1 AND d.direction = $2`,
      [routeId, direction],
    );
    return rows[0] ?? null;
  }

  #path(dir: { path: LatLng[] | null }, stops: StopView[]): LatLng[] {
    return dir.path?.length ? dir.path : stops.map((s) => ({ lat: s.lat, lng: s.lng }));
  }

  async listActive() {
    const { rows } = await this.pool.query(`SELECT id, code, name, city, corridor FROM fixed_routes.routes WHERE status = 'active' ORDER BY code`);
    return Promise.all(
      rows.map(async (r) => {
        const [taxi, van] = [fareAt(await this.rules(r.id, this.pool, 'taxi'), new Date()), fareAt(await this.rules(r.id, this.pool, 'van'), new Date())];
        return { ...r, currentFare: this.#fareView(taxi), currentFares: { taxi: this.#fareView(taxi), van: this.#fareView(van) } };
      }),
    );
  }

  #fareView(rule: FareRule | null) {
    return rule ? { name: rule.name, amountCents: rule.amountCents, currency: 'USD', perPerson: true } : null;
  }

  async detail(routeId: string, includeDraft = false) {
    const r = (await this.pool.query('SELECT id, code, name, city, corridor, status FROM fixed_routes.routes WHERE id = $1', [routeId])).rows[0];
    if (!r || (!includeDraft && r.status !== 'active')) throw new AppError(404, 'not_found', 'Ruta no encontrada');
    const dirs = (await this.pool.query(`SELECT id, direction, label, path, validation_report FROM fixed_routes.directions WHERE route_id = $1 ORDER BY direction DESC`, [routeId])).rows;
    const rules = await this.rules(routeId);
    const schedules = (await this.pool.query(`SELECT days_of_week AS days, to_char(service_start_local, 'HH24:MI') AS start, to_char(service_end_local, 'HH24:MI') AS "end", headway_minutes AS "headwayMinutes" FROM fixed_routes.schedules WHERE route_id = $1`, [routeId])).rows;
    return {
      ...r,
      timezone: 'America/Guayaquil',
      currentFare: this.#fareView(fareAt(rules.filter((f) => f.vehicleType === 'taxi'), new Date())),
      currentFares: { taxi: this.#fareView(fareAt(rules.filter((f) => f.vehicleType === 'taxi'), new Date())), van: this.#fareView(fareAt(rules.filter((f) => f.vehicleType === 'van'), new Date())) },
      fares: rules.map((f) => ({ vehicleType: f.vehicleType, name: f.name, from: f.startLocal.slice(0, 5), to: f.endLocal.slice(0, 5), amountCents: f.amountCents, validFrom: f.validFrom, validTo: f.validTo })),
      fareNote: 'La tarifa se fija con la hora de Guayaquil en el momento en que confirmas que subiste al vehículo.',
      schedules,
      directions: await Promise.all(dirs.map(async (d) => {
        const stops = await this.stops(d.id);
        return { direction: d.direction, label: d.label, stops, path: this.#path(d, stops), ...(includeDraft ? { validationReport: d.validation_report } : {}) };
      })),
    };
  }

  async #validateStops(routeId: string, direction: string, boardingStopId: string, alightingStopId: string, c: Pool | PoolClient = this.pool) {
    const dir = await this.#direction(routeId, direction, c);
    if (!dir || dir.status !== 'active') throw new AppError(404, 'not_found', 'Ruta no disponible');
    const stops = await this.stops(dir.id, c);
    const from = stops.find((s) => s.id === boardingStopId);
    const to = stops.find((s) => s.id === alightingStopId);
    if (!from || !to) throw new AppError(400, 'invalid_stop', 'Parada no pertenece a este sentido de la ruta');
    if (from.seq >= to.seq) throw new AppError(400, 'invalid_stop_order', 'La parada de bajada debe estar después de la de subida en este sentido');
    const path = this.#path(dir, stops);
    const distanceM = Math.max(0, Math.round(projectOnPath(path, to).alongM - projectOnPath(path, from).alongM));
    return { dir, stops, from, to, path, distanceM };
  }

  async quote(routeId: string, input: { direction: string; boardingStopId: string; alightingStopId: string; seats: number; vehicleType?: VehicleType }) {
    const v = await this.#validateStops(routeId, input.direction, input.boardingStopId, input.alightingStopId);
    const vehicleType = input.vehicleType ?? 'taxi';
    const rule = fareAt(await this.rules(routeId, this.pool, vehicleType), new Date());
    if (!rule) throw new AppError(409, 'no_fare', 'La ruta no tiene tarifa vigente en este horario');
    return {
      estimated: true,
      vehicleType,
      unitFareCents: rule.amountCents,
      fareName: rule.name,
      seats: input.seats,
      totalCents: rule.amountCents * input.seats,
      currency: 'USD',
      localTime: localParts(new Date()).time.slice(0, 5),
      note: 'Estimado: el precio final se fija al confirmar tu subida (hora de Guayaquil). Si subes desde las 21:00 aplica la tarifa nocturna.',
      distanceM: v.distanceM,
    };
  }

  /** Vehículos de la ruta en este sentido, con asientos libres y ETA a la parada (solo si aún no la pasaron). */
  async vehicles(routeId: string, direction: string, stopId?: string) {
    const dir = await this.#direction(routeId, direction);
    if (!dir || dir.status !== 'active') throw new AppError(404, 'not_found', 'Ruta no disponible');
    const stops = await this.stops(dir.id);
    const path = this.#path(dir, stops);
    const stop = stopId ? stops.find((s) => s.id === stopId) : undefined;
    const { rows } = await this.pool.query(
      `SELECT i.id, i.driver_id, i.vehicle_type, i.seats_total - i.seats_taken AS free, v.plate, v.color, v.make, v.model
       FROM fixed_routes.instances i JOIN drivers.vehicles v ON v.id = i.vehicle_id WHERE i.direction_id = $1 AND i.status = 'in_service'`,
      [dir.id],
    );
    const fares = { taxi: fareAt(await this.rules(routeId, this.pool, 'taxi'), new Date()), van: fareAt(await this.rules(routeId, this.pool, 'van'), new Date()) };
    const out = [];
    for (const r of rows) {
      const loc = await this.presence.lastLocation(r.driver_id);
      const eta = loc && stop ? etaSeconds(path, loc, stop) : null;
      if (stop && loc && eta === null) continue; // ya pasó la parada
      const fare = fares[r.vehicle_type as VehicleType];
      out.push({
        instanceId: r.id,
        vehicleType: r.vehicle_type,
        vehicleLabel: VEHICLE_LABEL[r.vehicle_type as VehicleType],
        seatsAvailable: r.free,
        vehicle: { plate: r.plate, color: r.color, make: r.make, model: r.model },
        location: loc ? { lat: loc.lat, lng: loc.lng } : null,
        etaSeconds: eta,
        currentUnitFareCents: fare?.amountCents ?? null,
        currentFareName: fare?.name ?? null,
      });
    }
    return out.sort((a, b) => (a.etaSeconds ?? 1e9) - (b.etaSeconds ?? 1e9));
  }

  // ---------- Reserva ----------

  async book(userId: string, device: AttestedDevice, routeId: string, input: Record<string, unknown> & { instanceId: string; direction: string; boardingStopId: string; alightingStopId: string; seats: number; paymentMethod: string }, req: AppRequest) {
    const rl = await this.limiter.hit(`route-book:${userId}`, 10, 3600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    if (input.paymentMethod !== 'cash' && device.flags.includes('device_integrity_basic_only')) throw new AppError(403, 'payment_method_not_allowed', 'En este dispositivo solo está disponible el pago en efectivo');
    await this.sanctions.assertAllowed(userId, 'passenger');
    const active = await this.pool.query(`SELECT 1 FROM fixed_routes.bookings WHERE requester_user_id = $1 AND status IN ('reserved', 'boarded')`, [userId]);
    if (active.rowCount) throw new AppError(409, 'active_booking_exists', 'Ya tienes una reserva activa en Taxi Ruta');
    const tripId = randomUUID();
    const bookingId = randomUUID();
    const pin = randomInt(0, 10_000).toString().padStart(4, '0');
    let driverId = '';
    await withTransaction(this.pool, async (c) => {
      const v = await this.#validateStops(routeId, input.direction, input.boardingStopId, input.alightingStopId, c);
      const inst = (await c.query(`SELECT * FROM fixed_routes.instances WHERE id = $1 AND direction_id = $2 AND status = 'in_service' FOR UPDATE`, [input.instanceId, v.dir.id])).rows[0];
      if (!inst) throw new AppError(404, 'not_found', 'Vehículo no disponible en esta ruta y sentido');
      if (inst.seats_total - inst.seats_taken < input.seats) throw new AppError(409, 'not_enough_seats', 'No hay asientos suficientes en este vehículo');
      const loc = await this.presence.lastLocation(inst.driver_id);
      if (loc && etaSeconds(v.path, loc, v.from) === null) throw new AppError(409, 'stop_passed', 'Este vehículo ya pasó por tu parada');
      const rule = fareAt(await this.rules(routeId, c, inst.vehicle_type), new Date());
      if (!rule) throw new AppError(409, 'no_fare', `La ruta no tiene tarifa vigente para ${VEHICLE_LABEL[inst.vehicle_type as VehicleType].toLowerCase()} en este horario`);
      driverId = inst.driver_id;
      await c.query(
        `INSERT INTO trips.trips (id, type, requester_user_id, driver_id, vehicle_id, status, origin_lat, origin_lng, dest_lat, dest_lng, distance_m, duration_s,
           quoted_fare_cents, party_size, payment_method, payment_method_id, pin_enc, accepted_at)
         VALUES ($1, 'fixed_route', $2, $3, $4, 'accepted', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())`,
        [tripId, userId, inst.driver_id, inst.vehicle_id, v.from.lat, v.from.lng, v.to.lat, v.to.lng, v.distanceM, Math.round(v.distanceM / (20_000 / 3600)),
          rule.amountCents * input.seats, input.seats, input.paymentMethod, (input.paymentMethodId as string) ?? null, await this.cipher.encrypt(pin, tripAad.pin(tripId))],
      );
      // Mismos registros que un viaje normal: cada persona adicional (sección 5.1) y validación del medio de pago.
      for (const h of this.trips.hooks) {
        const r = await h.beforeCreate?.(c, { id: tripId, requesterUserId: userId, deviceId: device.deviceId }, input, req);
        if (r?.partySize && r.partySize !== input.seats) throw new AppError(400, 'party_mismatch', `Reservaste ${input.seats} asiento(s): registra a cada persona adicional (tienes ${r.partySize})`);
        if (r?.isForThirdParty) await c.query('UPDATE trips.trips SET is_for_third_party = true WHERE id = $1', [tripId]);
      }
      await c.query(
        `INSERT INTO fixed_routes.bookings (id, instance_id, trip_id, requester_user_id, boarding_stop_id, alighting_stop_id, seats, status, estimated_unit_fare_cents, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, now() + make_interval(mins => $9))`,
        [bookingId, inst.id, tripId, userId, v.from.id, v.to.id, input.seats, rule.amountCents, BOOKING_TTL_MIN],
      );
      await c.query('UPDATE fixed_routes.instances SET seats_taken = seats_taken + $2 WHERE id = $1', [inst.id, input.seats]);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id, data) VALUES ($1, 'route_booked', 'requester', $2, $3)`, [tripId, userId, { routeId, bookingId, seats: input.seats }]);
      await this.audit.record({ action: 'route.book', resourceType: 'trip', resourceId: tripId, metadata: { routeId, seats: input.seats } }, req, c);
    });
    this.events.emitStatus({ tripId, from: null, to: 'accepted', requesterUserId: userId, driverId });
    return { bookingId, tripId, ...(await this.bookingView(userId, bookingId)) };
  }

  async bookingView(userId: string, bookingId: string) {
    const { rows } = await this.pool.query(
      `SELECT b.*, sb.name AS boarding, sa.name AS alighting, v.plate, v.color, v.make, v.model, i.vehicle_type, i.driver_id, i.vehicle_id, d.route_id, d.direction
       FROM fixed_routes.bookings b JOIN fixed_routes.stops sb ON sb.id = b.boarding_stop_id JOIN fixed_routes.stops sa ON sa.id = b.alighting_stop_id
       JOIN fixed_routes.instances i ON i.id = b.instance_id JOIN drivers.vehicles v ON v.id = i.vehicle_id JOIN fixed_routes.directions d ON d.id = i.direction_id
       WHERE b.id = $1 AND b.requester_user_id = $2`,
      [bookingId, userId],
    );
    const b = rows[0];
    if (!b) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return {
      status: b.status, seats: b.seats, boardingStop: b.boarding, alightingStop: b.alighting, vehicleType: b.vehicle_type, vehicleLabel: VEHICLE_LABEL[b.vehicle_type as VehicleType],
      vehicle: { plate: b.plate, color: b.color, make: b.make, model: b.model },
      fare: b.unit_fare_cents
        ? { final: true, ruleName: b.fare_rule_name, unitCents: b.unit_fare_cents, totalCents: b.unit_fare_cents * b.seats }
        : { final: false, estimatedUnitCents: b.estimated_unit_fare_cents, estimatedTotalCents: b.estimated_unit_fare_cents * b.seats },
      expiresAt: b.status === 'reserved' ? b.expires_at : null,
      switches: { used: b.switch_count, max: MAX_SWITCH },
      // Para que la app ofrezca otras unidades del mismo sentido al cambiar de vehículo.
      route: { id: b.route_id, direction: b.direction, boardingStopId: b.boarding_stop_id, instanceId: b.instance_id },
      driver: await this.trips.driverCard(b.driver_id, b.vehicle_id),
    };
  }

  /** Cambiar de unidad (otro vehículo del mismo sentido) antes de subir: máximo 5 veces; la sexta cancela la reserva. */
  async switchVehicle(userId: string, bookingId: string, instanceId: string, req: AppRequest) {
    const out = await withTransaction(this.pool, async (c) => {
      const b = (await c.query(`SELECT * FROM fixed_routes.bookings WHERE id = $1 AND requester_user_id = $2 FOR UPDATE`, [bookingId, userId])).rows[0];
      if (!b) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (b.status !== 'reserved') throw new AppError(409, 'invalid_state', 'Solo puedes cambiar de unidad antes de subir');
      if (b.switch_count >= MAX_SWITCH) {
        await this.#release(c, b, 'cancelled', 'system');
        return { closed: true as const, b };
      }
      if (b.instance_id === instanceId) throw new AppError(400, 'same_vehicle', 'Ya estás en esa unidad');
      // Bloqueo en orden fijo para evitar interbloqueos entre cambios simultáneos.
      const ids = [b.instance_id, instanceId].sort();
      const insts = (await c.query(`SELECT * FROM fixed_routes.instances WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids])).rows;
      const from = insts.find((i) => i.id === b.instance_id)!;
      const to = insts.find((i) => i.id === instanceId);
      if (!to || to.status !== 'in_service' || to.direction_id !== from.direction_id) throw new AppError(404, 'not_found', 'Esa unidad no está disponible en tu ruta y sentido');
      if (to.seats_total - to.seats_taken < b.seats) throw new AppError(409, 'not_enough_seats', 'Esa unidad no tiene asientos suficientes');
      const stop = (await c.query(`SELECT lat::float8 AS lat, lng::float8 AS lng FROM fixed_routes.stops WHERE id = $1`, [b.boarding_stop_id])).rows[0];
      const dir = (await c.query(`SELECT d.route_id, d.direction FROM fixed_routes.directions d WHERE d.id = $1`, [to.direction_id])).rows[0];
      const dirRow = await this.#direction(dir.route_id, dir.direction, c);
      const path = this.#path(dirRow!, await this.stops(to.direction_id, c));
      const loc = await this.presence.lastLocation(to.driver_id);
      if (loc && etaSeconds(path, loc, stop) === null) throw new AppError(409, 'stop_passed', 'Esa unidad ya pasó por tu parada');
      await c.query('UPDATE fixed_routes.instances SET seats_taken = seats_taken - $2 WHERE id = $1', [from.id, b.seats]);
      await c.query('UPDATE fixed_routes.instances SET seats_taken = seats_taken + $2 WHERE id = $1', [to.id, b.seats]);
      await c.query('UPDATE fixed_routes.bookings SET instance_id = $2, switch_count = switch_count + 1 WHERE id = $1', [bookingId, to.id]);
      await c.query('UPDATE trips.trips SET driver_id = $2, vehicle_id = $3 WHERE id = $1', [b.trip_id, to.driver_id, to.vehicle_id]);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id, data) VALUES ($1, 'reassigned', 'requester', $2, $3)`, [b.trip_id, userId, { fromInstance: from.id, toInstance: to.id }]);
      await this.audit.record({ action: 'route.switch_vehicle', resourceType: 'trip', resourceId: b.trip_id, metadata: { attempt: b.switch_count + 1 } }, req, c);
      return { closed: false as const, b, driverId: to.driver_id as string, remaining: MAX_SWITCH - (b.switch_count + 1) };
    });
    if (out.closed) {
      this.events.emitStatus({ tripId: out.b.trip_id, from: 'accepted', to: 'cancelled', requesterUserId: userId, driverId: null });
      throw new AppError(409, 'max_reassignments', 'Llegaste al máximo de 5 cambios de unidad: la reserva se cerró. Reserva de nuevo.');
    }
    this.events.emitStatus({ tripId: out.b.trip_id, from: 'accepted', to: 'accepted', requesterUserId: userId, driverId: out.driverId });
    return { bookingId, remainingSwitches: out.remaining, ...(await this.bookingView(userId, bookingId)) };
  }

  async cancel(userId: string, bookingId: string, req: AppRequest) {
    const out = await withTransaction(this.pool, async (c) => {
      const b = (await c.query(`SELECT * FROM fixed_routes.bookings WHERE id = $1 AND requester_user_id = $2 FOR UPDATE`, [bookingId, userId])).rows[0];
      if (!b) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (b.status !== 'reserved') throw new AppError(409, 'invalid_state', 'Solo se cancela una reserva antes de subir');
      await this.#release(c, b, 'cancelled', 'requester');
      await this.audit.record({ action: 'route.cancel', resourceType: 'trip', resourceId: b.trip_id }, req, c);
      return b;
    });
    this.events.emitStatus({ tripId: out.trip_id, from: 'accepted', to: 'cancelled', requesterUserId: userId, driverId: null });
    return { bookingId, status: 'cancelled' };
  }

  async #release(c: PoolClient, b: { id: string; instance_id: string; trip_id: string; seats: number }, status: 'cancelled' | 'expired', by: string) {
    await c.query(`UPDATE fixed_routes.bookings SET status = $2 WHERE id = $1`, [b.id, status]);
    await c.query('UPDATE fixed_routes.instances SET seats_taken = seats_taken - $2 WHERE id = $1', [b.instance_id, b.seats]);
    await c.query(`UPDATE trips.trips SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, ended_at = now() WHERE id = $1`, [b.trip_id, by === 'requester' ? 'requester' : 'system']);
    await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role) VALUES ($1, $2, $3)`, [b.trip_id, status, by]);
  }

  /** Reservas no abordadas a tiempo: se liberan los asientos. */
  async expireBookings() {
    const ended = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query(`SELECT * FROM fixed_routes.bookings WHERE status = 'reserved' AND expires_at < now() FOR UPDATE SKIP LOCKED LIMIT 100`);
      for (const b of rows) await this.#release(c, b, 'expired', 'system');
      return rows;
    });
    for (const b of ended) this.events.emitStatus({ tripId: b.trip_id, from: 'accepted', to: 'cancelled', requesterUserId: b.requester_user_id, driverId: null });
    return ended.length;
  }

  // ---------- Conductor ----------

  async enabledRoutes(driverId: string) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.code, r.name, r.status FROM fixed_routes.driver_enablements e JOIN fixed_routes.routes r ON r.id = e.route_id WHERE e.driver_id = $1 AND e.revoked_at IS NULL`,
      [driverId],
    );
    return rows;
  }

  async startInstance(driverId: string, routeId: string, direction: string, vehicleId: string, req: AppRequest) {
    const en = await this.pool.query(`SELECT 1 FROM fixed_routes.driver_enablements WHERE driver_id = $1 AND route_id = $2 AND revoked_at IS NULL`, [driverId, routeId]);
    if (!en.rowCount) throw new AppError(403, 'not_enabled', 'No estás habilitado para esta ruta');
    const dir = await this.#direction(routeId, direction);
    if (!dir || dir.status !== 'active') throw new AppError(404, 'not_found', 'Ruta no disponible');
    const issues = await this.drivers.eligibility(driverId);
    if (issues.length) throw new AppError(403, 'not_eligible', `No puedes operar: ${issues.join(', ')}`);
    await this.kyc.assertDriverIdentityFresh(driverId);
    const st = await this.presence.state(driverId);
    if (!st) throw new AppError(409, 'offline', 'Conéctate primero (con tu ubicación)');
    if (st.tripId) throw new AppError(409, 'busy', 'Termina tu viaje o recorrido actual');
    const v = (await this.pool.query(`SELECT seats_passenger, vehicle_type FROM drivers.vehicles WHERE id = $1 AND driver_id = $2 AND status = 'approved'`, [vehicleId, driverId])).rows[0];
    if (!v) throw new AppError(404, 'not_found', 'Vehículo no encontrado o no aprobado');
    if (v.vehicle_type !== 'taxi' && v.vehicle_type !== 'van') throw new AppError(409, 'invalid_vehicle', 'Taxi Ruta es solo para taxis y furgonetas');
    if (!(await this.rules(routeId, this.pool, v.vehicle_type)).length) throw new AppError(409, 'no_fare', `Esta ruta no tiene tarifas para ${VEHICLE_LABEL[v.vehicle_type as VehicleType].toLowerCase()}`);
    const id = randomUUID();
    await this.pool.query(`INSERT INTO fixed_routes.instances (id, direction_id, driver_id, vehicle_id, status, seats_total, vehicle_type) VALUES ($1, $2, $3, $4, 'in_service', $5, $6)`, [id, dir.id, driverId, vehicleId, v.seats_passenger, v.vehicle_type])
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'busy', 'Ya tienes un recorrido en servicio') : e;
      });
    // Mientras hace la ruta no recibe viajes bajo demanda.
    await this.presence.setTrip(driverId, `route:${id}`);
    await this.audit.record({ action: 'route.instance_start', resourceType: 'route', resourceId: routeId, metadata: { instanceId: id, direction } }, req);
    return { instanceId: id, seatsTotal: v.seats_passenger, vehicleType: v.vehicle_type };
  }

  async #ownInstance(driverId: string, instanceId: string, c: Pool | PoolClient = this.pool) {
    const inst = (await c.query(`SELECT * FROM fixed_routes.instances WHERE id = $1 AND driver_id = $2`, [instanceId, driverId])).rows[0];
    if (!inst) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return inst;
  }

  async currentInstance(driverId: string) {
    const inst = (await this.pool.query(`SELECT * FROM fixed_routes.instances WHERE driver_id = $1 AND status = 'in_service'`, [driverId])).rows[0];
    if (!inst) return null;
    const { rows } = await this.pool.query(
      `SELECT b.id, b.status, b.seats, b.trip_id, sb.name AS boarding, sb.lat::float8 AS "boardingLat", sb.lng::float8 AS "boardingLng", sa.name AS alighting
       FROM fixed_routes.bookings b JOIN fixed_routes.stops sb ON sb.id = b.boarding_stop_id JOIN fixed_routes.stops sa ON sa.id = b.alighting_stop_id
       WHERE b.instance_id = $1 AND b.status IN ('reserved', 'boarded') ORDER BY b.created_at`,
      [inst.id],
    );
    return { instanceId: inst.id, vehicleType: inst.vehicle_type, seatsTotal: inst.seats_total, seatsTaken: inst.seats_taken, bookings: rows };
  }

  /** Confirmación de abordaje con el PIN del pasajero: aquí se FIJA la tarifa (hora de Guayaquil). */
  async board(driverId: string, instanceId: string, bookingId: string, pin: string, req: AppRequest) {
    await this.#ownInstance(driverId, instanceId);
    const b = (await this.pool.query(`SELECT b.*, t.pin_enc, t.pin_attempts, t.requester_user_id FROM fixed_routes.bookings b JOIN trips.trips t ON t.id = b.trip_id WHERE b.id = $1 AND b.instance_id = $2`, [bookingId, instanceId])).rows[0];
    if (!b) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (b.status !== 'reserved') throw new AppError(409, 'invalid_state', 'La reserva no está pendiente de abordaje');
    if (b.pin_attempts >= MAX_PIN_ATTEMPTS) throw new AppError(423, 'pin_locked', 'Demasiados intentos de PIN');
    const real = await this.cipher.decrypt(b.pin_enc, tripAad.pin(b.trip_id));
    if (!/^\d{4}$/.test(pin) || !constantTimeEqual(Buffer.from(pin), Buffer.from(real))) {
      await this.pool.query('UPDATE trips.trips SET pin_attempts = pin_attempts + 1 WHERE id = $1', [b.trip_id]);
      await this.audit.record({ action: 'trip.pin_failed', resourceType: 'trip', resourceId: b.trip_id, outcome: 'denied' }, req);
      throw new AppError(400, 'invalid_pin', 'PIN incorrecto');
    }
    const boardedAt = new Date();
    const { route_id: routeId, vehicle_type: vehicleType } = (
      await this.pool.query(`SELECT d.route_id, i.vehicle_type FROM fixed_routes.instances i JOIN fixed_routes.directions d ON d.id = i.direction_id WHERE i.id = $1`, [instanceId])
    ).rows[0];
    const rule = fareAt(await this.rules(routeId, this.pool, vehicleType), boardedAt);
    if (!rule) throw new AppError(409, 'no_fare', 'Sin tarifa vigente');
    await withTransaction(this.pool, async (c) => {
      const u = await c.query(
        `UPDATE fixed_routes.bookings SET status = 'boarded', boarded_at = $2, fare_rule_id = $3, fare_rule_name = $4, unit_fare_cents = $5 WHERE id = $1 AND status = 'reserved'`,
        [bookingId, boardedAt, rule.id, rule.name, rule.amountCents],
      );
      if (!u.rowCount) throw new AppError(409, 'invalid_state', 'La reserva ya no está pendiente');
      await c.query(`UPDATE trips.trips SET status = 'in_progress', started_at = $2, arrived_at = $2, final_fare_cents = $3 WHERE id = $1`, [b.trip_id, boardedAt, rule.amountCents * b.seats]);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id, data) VALUES ($1, 'in_progress', 'driver', $2, $3)`, [b.trip_id, driverId, { fareRule: rule.name, unitCents: rule.amountCents, localTime: localParts(boardedAt).time }]);
      await this.audit.record({ action: 'route.board', resourceType: 'trip', resourceId: b.trip_id, metadata: { fareRule: rule.name, unitCents: rule.amountCents } }, req, c);
    });
    this.events.emitStatus({ tripId: b.trip_id, from: 'accepted', to: 'in_progress', requesterUserId: b.requester_user_id, driverId });
    return { bookingId, status: 'boarded', fare: { ruleName: rule.name, unitCents: rule.amountCents, totalCents: rule.amountCents * b.seats, localTime: localParts(boardedAt).time } };
  }

  async alight(driverId: string, instanceId: string, bookingId: string, req: AppRequest) {
    await this.#ownInstance(driverId, instanceId);
    const b = await withTransaction(this.pool, async (c) => {
      const row = (await c.query(`SELECT * FROM fixed_routes.bookings WHERE id = $1 AND instance_id = $2 AND status = 'boarded' FOR UPDATE`, [bookingId, instanceId])).rows[0];
      if (!row) throw new AppError(404, 'not_found', 'Pasajero no está a bordo');
      await c.query(`UPDATE fixed_routes.bookings SET status = 'completed', alighted_at = now() WHERE id = $1`, [bookingId]);
      await c.query('UPDATE fixed_routes.instances SET seats_taken = seats_taken - $2 WHERE id = $1', [instanceId, row.seats]);
      await c.query(`UPDATE trips.trips SET status = 'completed', ended_at = now() WHERE id = $1`, [row.trip_id]);
      await c.query(`INSERT INTO trips.trip_events (trip_id, event, actor_role, actor_id) VALUES ($1, 'completed', 'driver', $2)`, [row.trip_id, driverId]);
      await this.audit.record({ action: 'route.alight', resourceType: 'trip', resourceId: row.trip_id }, req, c);
      return row;
    });
    this.events.emitStatus({ tripId: b.trip_id, from: 'in_progress', to: 'completed', requesterUserId: b.requester_user_id, driverId });
    return { bookingId, status: 'completed' };
  }

  async finish(driverId: string, instanceId: string, req: AppRequest) {
    const inst = await this.#ownInstance(driverId, instanceId);
    if (inst.status !== 'in_service') throw new AppError(409, 'invalid_state', 'El recorrido ya terminó');
    const ended = await withTransaction(this.pool, async (c) => {
      const onboard = await c.query(`SELECT 1 FROM fixed_routes.bookings WHERE instance_id = $1 AND status = 'boarded'`, [instanceId]);
      if (onboard.rowCount) throw new AppError(409, 'passengers_on_board', 'Aún hay pasajeros a bordo');
      const pending = (await c.query(`SELECT * FROM fixed_routes.bookings WHERE instance_id = $1 AND status = 'reserved' FOR UPDATE`, [instanceId])).rows;
      for (const b of pending) await this.#release(c, b, 'cancelled', 'driver');
      const done = await c.query(`UPDATE fixed_routes.instances SET status = 'finished', finished_at = now() WHERE id = $1 AND status = 'in_service'`, [instanceId]);
      if (!done.rowCount) throw new AppError(409, 'invalid_state', 'El recorrido ya terminó');
      // Comisión fija por recorrido (solo si llevó pasajeros): se descuenta de lo que se le debe al conductor.
      const carried = await c.query(`SELECT 1 FROM fixed_routes.bookings WHERE instance_id = $1 AND status = 'completed' LIMIT 1`, [instanceId]);
      const fee = carried.rowCount ? await this.commissions.routeFee(inst.vehicle_type, c) : 0;
      if (fee > 0) {
        await postLedger(c, 'route_instance_fee', { type: 'route_instance', id: instanceId }, [{ account: `driver_payable:${driverId}`, debit: fee }, { account: 'platform_revenue', credit: fee }]);
      }
      await c.query('UPDATE fixed_routes.instances SET platform_fee_cents = $2 WHERE id = $1', [instanceId, fee]);
      await this.audit.record({ action: 'route.instance_finish', resourceType: 'route_instance', resourceId: instanceId, metadata: { cancelledBookings: pending.length, feeCents: fee } }, req, c);
      return pending;
    });
    await this.presence.setTrip(driverId, null);
    for (const b of ended) this.events.emitStatus({ tripId: b.trip_id, from: 'accepted', to: 'cancelled', requesterUserId: b.requester_user_id, driverId });
    const fee = (await this.pool.query('SELECT platform_fee_cents FROM fixed_routes.instances WHERE id = $1', [instanceId])).rows[0].platform_fee_cents;
    return { instanceId, status: 'finished', cancelledBookings: ended.length, platformFeeCents: fee };
  }
}
