import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { GUAYAQUIL_BBOX, haversineMeters, inBBox, offerWithinBounds, suggestRental, suggestTow, type LatLng, type RentalCategory, type TowCategory } from '@intitaxi/domain';
import { AppError, AuditService, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import type { MapsPort } from '../../infra/maps.js';
import { FIELD_CIPHER, MAPS, PG_POOL } from '../../tokens.js';
import { DriversService } from '../drivers/drivers.service.js';
import { KycService } from '../kyc/kyc.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CommissionService } from '../payments/commission.service.js';
import { postLedger } from '../payments/ledger.js';
import { PresenceService } from '../trips/presence.service.js';
import { TripsService } from '../trips/trips.service.js';
import { SanctionsService } from '../trust/sanctions.service.js';

export type AssistKind = 'tow' | 'rental';
const TTL_MIN: Record<AssistKind, number> = { tow: 15, rental: 60 };
const TOW_RADIUS_M = 15_000;
const ACTIVE = ['accepted', 'arrived', 'in_progress'];
const aad = (id: string, f: string) => `assist.requests.${f}:${id}`;

export interface TowInput {
  kind: 'tow';
  pickup: LatLng;
  destination: LatLng;
  pickupLabel?: string;
  destinationLabel?: string;
  vehicleCategory: TowCategory;
  problem: 'no_enciende' | 'choque' | 'llanta' | 'sin_combustible' | 'otro';
  notes?: string;
  offerCents: number;
}

export interface RentalInput {
  kind: 'rental';
  pickup: LatLng;
  pickupLabel?: string;
  vehicleCategory: RentalCategory;
  startDate: string;
  days: number;
  notes?: string;
  offerCents: number;
}

/**
 * Grúas y alquiler de vehículos: el usuario ofrece cuánto quiere pagar (dentro de un rango razonable
 * respecto al precio sugerido) y el PRIMER proveedor verificado que acepta se lleva el servicio.
 * La aceptación es atómica: dos proveedores no pueden tomar la misma solicitud.
 */
@Injectable()
export class AssistService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('Assist');
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(MAPS) private readonly maps: MapsPort,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(DriversService) private readonly drivers: DriversService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(SanctionsService) private readonly sanctions: SanctionsService,
    @Inject(CommissionService) private readonly commissions: CommissionService,
    @Inject(NotificationsService) private readonly notify: NotificationsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // La ubicación de la grúa en servicio no se guarda como ruta de viaje (se consulta en vivo).
    const previous = this.presence.onTripLocation;
    this.presence.onTripLocation = async (tripId, loc) => (tripId.startsWith('assist:') ? undefined : previous?.(tripId, loc));
    this.#timer = setInterval(() => void this.expire().catch((e) => this.#log.error(e.message)), 30_000);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  #inArea(...pts: LatLng[]) {
    for (const p of pts) if (!inBBox(p, GUAYAQUIL_BBOX)) throw new AppError(422, 'outside_service_area', 'Por ahora solo operamos en Guayaquil');
  }

  /** Precio sugerido (el usuario decide cuánto ofrecer dentro del rango permitido). */
  async suggest(input: { kind: 'tow'; pickup: LatLng; destination: LatLng; vehicleCategory: TowCategory } | { kind: 'rental'; vehicleCategory: RentalCategory; days: number }) {
    if (input.kind === 'tow') {
      this.#inArea(input.pickup, input.destination);
      const r = await this.maps.route(input.pickup, input.destination);
      return { ...suggestTow(r.distanceM, input.vehicleCategory), distanceM: r.distanceM, currency: 'USD' };
    }
    return { ...suggestRental(input.vehicleCategory, input.days), currency: 'USD' };
  }

  // ---------- Usuario ----------

  async create(userId: string, input: TowInput | RentalInput, req: AppRequest) {
    await this.sanctions.assertAllowed(userId, 'passenger');
    const rl = await this.limiter.hit(`assist:${userId}`, 10, 3600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    // Alquilar exige identidad verificada (biometría + cédula): se entrega un vehículo a esa persona.
    if (input.kind === 'rental' && !(await this.kyc.isApproved(userId))) throw new AppError(409, 'kyc_required', 'Para alquilar un vehículo primero verifica tu identidad');
    if (input.kind === 'rental') {
      this.#inArea(input.pickup);
      const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' })).toISOString().slice(0, 10);
      if (input.startDate < today) throw new AppError(400, 'invalid_date', 'La fecha de inicio no puede ser pasada');
    }
    const s = input.kind === 'tow' ? await this.suggest(input) : await this.suggest(input);
    if (!offerWithinBounds(input.offerCents, s)) throw new AppError(400, 'offer_out_of_range', `Tu oferta debe estar entre $${(Math.floor(s.minCents * 0.5) / 100).toFixed(2)} y $${((s.maxCents * 3) / 100).toFixed(2)}`);
    const id = randomUUID();
    const enc = async (v: string | undefined, f: string) => (v ? this.cipher.encrypt(v, aad(id, f)) : null);
    await this.pool
      .query(
        `INSERT INTO assist.requests (id, kind, requester_user_id, status, offer_cents, suggested_min_cents, suggested_max_cents, pickup_lat, pickup_lng, pickup_label_enc,
           dest_lat, dest_lng, dest_label_enc, distance_m, vehicle_category, problem, start_date, days, notes_enc, expires_at)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now() + make_interval(mins => $19))`,
        [
          id, input.kind, userId, input.offerCents, s.minCents, s.maxCents, input.pickup.lat, input.pickup.lng, await enc(input.pickupLabel, 'pickup'),
          input.kind === 'tow' ? input.destination.lat : null, input.kind === 'tow' ? input.destination.lng : null, input.kind === 'tow' ? await enc(input.destinationLabel, 'dest') : null,
          'distanceM' in s ? s.distanceM : null, input.vehicleCategory, input.kind === 'tow' ? input.problem : null,
          input.kind === 'rental' ? input.startDate : null, input.kind === 'rental' ? input.days : null, await enc(input.notes, 'notes'), TTL_MIN[input.kind],
        ],
      )
      .catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'active_request_exists', 'Ya tienes una solicitud activa de este servicio') : e;
      });
    await this.audit.record({ action: `assist.${input.kind}.request`, resourceType: 'assist_request', resourceId: id, metadata: { offerCents: input.offerCents } }, req);
    return this.view(userId, id);
  }

  /** Subir la oferta mientras nadie acepta (nunca bajarla: los proveedores ya la vieron). */
  async raise(userId: string, id: string, offerCents: number, req: AppRequest) {
    const r = (await this.pool.query(`SELECT * FROM assist.requests WHERE id = $1 AND requester_user_id = $2`, [id, userId])).rows[0];
    if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (offerCents <= r.offer_cents) throw new AppError(400, 'offer_must_increase', 'Solo puedes subir tu oferta');
    if (!offerWithinBounds(offerCents, { minCents: r.suggested_min_cents, maxCents: r.suggested_max_cents })) throw new AppError(400, 'offer_out_of_range', 'La oferta supera el máximo permitido');
    const u = await this.pool.query(`UPDATE assist.requests SET offer_cents = $3 WHERE id = $1 AND requester_user_id = $2 AND status = 'open'`, [id, userId, offerCents]);
    if (!u.rowCount) throw new AppError(409, 'invalid_state', 'La solicitud ya fue tomada o venció');
    await this.audit.record({ action: 'assist.raise', resourceType: 'assist_request', resourceId: id, metadata: { offerCents } }, req);
    return this.view(userId, id);
  }

  async view(userId: string, id: string) {
    const r = (await this.pool.query(`SELECT * FROM assist.requests WHERE id = $1 AND (requester_user_id = $2 OR provider_id = $2)`, [id, userId])).rows[0];
    if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const dec = (b: Buffer | null, f: string) => (b ? this.cipher.decrypt(b, aad(id, f)) : Promise.resolve(null));
    const provider = r.provider_id ? await this.trips.driverCard(r.provider_id, r.vehicle_id) : null;
    const loc = r.provider_id && r.kind === 'tow' && ACTIVE.includes(r.status) ? await this.presence.lastLocation(r.provider_id) : null;
    return {
      id, kind: r.kind, status: r.status, role: r.requester_user_id === userId ? 'requester' : 'provider',
      offerCents: r.offer_cents, suggested: { minCents: r.suggested_min_cents, maxCents: r.suggested_max_cents },
      pickup: { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng), label: await dec(r.pickup_label_enc, 'pickup') },
      destination: r.dest_lat ? { lat: Number(r.dest_lat), lng: Number(r.dest_lng), label: await dec(r.dest_label_enc, 'dest') } : null,
      vehicleCategory: r.vehicle_category, problem: r.problem, startDate: r.start_date, days: r.days, distanceM: r.distance_m,
      notes: await dec(r.notes_enc, 'notes'),
      provider, providerLocation: loc ? { lat: loc.lat, lng: loc.lng } : null,
      paymentMethod: r.payment_method, expiresAt: r.status === 'open' ? r.expires_at : null, rating: r.rating,
    };
  }

  async cancel(userId: string, id: string, reason: string | undefined, req: AppRequest) {
    const r = await withTransaction(this.pool, async (c) => {
      const row = (await c.query(`SELECT * FROM assist.requests WHERE id = $1 AND requester_user_id = $2 FOR UPDATE`, [id, userId])).rows[0];
      if (!row) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (!['open', 'accepted', 'arrived'].includes(row.status)) throw new AppError(409, 'invalid_state', 'Ya no se puede cancelar');
      await c.query(`UPDATE assist.requests SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [id, reason ?? null]);
      await this.audit.record({ action: 'assist.cancel', resourceType: 'assist_request', resourceId: id }, req, c);
      return row;
    });
    if (r.provider_id) {
      if (r.kind === 'tow') await this.presence.setTrip(r.provider_id, null);
      await this.notify.notifyUser(r.provider_id, 'assist_cancelled', { sms: 'Inti Taxi: el cliente canceló el servicio que habías aceptado.' });
    }
    return { id, status: 'cancelled' };
  }

  async rate(userId: string, id: string, stars: number, req: AppRequest) {
    const u = await this.pool.query(`UPDATE assist.requests SET rating = $3 WHERE id = $1 AND requester_user_id = $2 AND status = 'completed' AND rating IS NULL`, [id, userId, stars]);
    if (!u.rowCount) throw new AppError(409, 'not_rateable', 'Solo se califica una vez un servicio completado');
    await this.audit.record({ action: 'assist.rate', resourceType: 'assist_request', resourceId: id, metadata: { stars } }, req);
    return { id, rating: stars };
  }

  // ---------- Proveedor ----------

  /** Solicitudes abiertas que el proveedor puede tomar (sin datos personales del cliente antes de aceptar). */
  async openFor(providerId: string, kind: AssistKind) {
    if ((await this.drivers.eligibility(providerId)).length) throw new AppError(403, 'not_eligible', 'Tu cuenta no está habilitada para recibir servicios');
    const vehicles = (await this.drivers.vehicles(providerId)).filter((v) => v.status === 'approved' && v.vehicle_type === kind) as { rental_category?: string }[];
    if (!vehicles.length) throw new AppError(403, 'no_vehicle', kind === 'tow' ? 'Necesitas una grúa aprobada' : 'Necesitas un vehículo de alquiler aprobado');
    let origin: LatLng | null = null;
    if (kind === 'tow') {
      const st = await this.presence.state(providerId);
      if (!st || st.vehicleType !== 'tow') throw new AppError(409, 'offline', 'Conéctate con tu grúa para ver solicitudes');
      origin = await this.presence.lastLocation(providerId);
    }
    const categories = kind === 'rental' ? (await this.pool.query(`SELECT DISTINCT rental_category FROM drivers.vehicles WHERE driver_id = $1 AND vehicle_type = 'rental' AND status = 'approved'`, [providerId])).rows.map((r) => r.rental_category) : null;
    const { rows } = await this.pool.query(
      `SELECT id, kind, offer_cents, suggested_min_cents, suggested_max_cents, pickup_lat::float8 AS lat, pickup_lng::float8 AS lng, distance_m, vehicle_category, problem, start_date, days, expires_at
       FROM assist.requests WHERE kind = $1 AND status = 'open' AND expires_at > now() AND requester_user_id <> $2 AND ($3::text[] IS NULL OR vehicle_category = ANY($3)) ORDER BY created_at LIMIT 50`,
      [kind, providerId, categories],
    );
    return rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        offerCents: r.offer_cents,
        suggested: { minCents: r.suggested_min_cents, maxCents: r.suggested_max_cents },
        // Zona aproximada (≈100 m) hasta aceptar.
        pickupArea: { lat: Math.round(r.lat * 1000) / 1000, lng: Math.round(r.lng * 1000) / 1000 },
        distanceToPickupM: origin ? Math.round(haversineMeters(origin, { lat: r.lat, lng: r.lng })) : null,
        tripDistanceM: r.distance_m,
        vehicleCategory: r.vehicle_category,
        problem: r.problem,
        startDate: r.start_date,
        days: r.days,
        expiresAt: r.expires_at,
      }))
      .filter((r) => r.distanceToPickupM === null || r.distanceToPickupM <= TOW_RADIUS_M);
  }

  /** El primero que acepta se lleva el servicio (UPDATE condicional: atómico). */
  async accept(providerId: string, id: string, vehicleId: string, req: AppRequest) {
    if ((await this.drivers.eligibility(providerId)).length) throw new AppError(403, 'not_eligible', 'Tu cuenta no está habilitada para recibir servicios');
    const r0 = (await this.pool.query(`SELECT kind, vehicle_category FROM assist.requests WHERE id = $1`, [id])).rows[0];
    if (!r0) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const v = (await this.pool.query(`SELECT vehicle_type, rental_category FROM drivers.vehicles WHERE id = $1 AND driver_id = $2 AND status = 'approved'`, [vehicleId, providerId])).rows[0];
    if (!v || v.vehicle_type !== r0.kind || (r0.kind === 'rental' && v.rental_category !== r0.vehicle_category)) throw new AppError(400, 'invalid_vehicle', 'Ese vehículo no corresponde a esta solicitud');
    if (r0.kind === 'tow') {
      await this.kyc.assertDriverIdentityFresh(providerId);
      const st = await this.presence.state(providerId);
      if (!st || st.vehicleType !== 'tow') throw new AppError(409, 'offline', 'Conéctate con tu grúa');
      if (st.tripId) throw new AppError(409, 'busy', 'Termina tu servicio actual');
    }
    const u = await this.pool.query(
      `UPDATE assist.requests SET status = 'accepted', provider_id = $2, vehicle_id = $3, accepted_at = now()
       WHERE id = $1 AND status = 'open' AND expires_at > now() AND requester_user_id <> $2 RETURNING requester_user_id, offer_cents`,
      [id, providerId, vehicleId],
    );
    if (!u.rowCount) throw new AppError(409, 'already_taken', 'Otro proveedor ya tomó esta solicitud o venció');
    if (r0.kind === 'tow') await this.presence.setTrip(providerId, `assist:${id}`);
    await this.audit.record({ action: 'assist.accept', resourceType: 'assist_request', resourceId: id, metadata: { offerCents: u.rows[0].offer_cents } }, req);
    const card = await this.trips.driverCard(providerId, vehicleId);
    await this.notify.notifyUser(u.rows[0].requester_user_id, 'assist_accepted', {
      sms: r0.kind === 'tow' ? `Inti Taxi: tu grúa va en camino (placa ${card.vehicle?.plate}).` : `Inti Taxi: ${card.firstName} aceptó tu solicitud de alquiler (placa ${card.vehicle?.plate}).`,
    });
    return this.view(providerId, id);
  }

  /** Avance del servicio por el proveedor; al completarse se registra la comisión. */
  async progress(providerId: string, id: string, to: 'arrived' | 'in_progress' | 'completed', req: AppRequest) {
    const FROM: Record<string, string> = { arrived: 'accepted', in_progress: 'arrived', completed: 'in_progress' };
    const done = await withTransaction(this.pool, async (c) => {
      const r = (await c.query(`SELECT * FROM assist.requests WHERE id = $1 AND provider_id = $2 FOR UPDATE`, [id, providerId])).rows[0];
      if (!r) throw new AppError(404, 'not_found', 'Recurso no encontrado');
      if (r.status !== FROM[to]) throw new AppError(409, 'invalid_state', `No se puede pasar de ${r.status} a ${to}`);
      await c.query(`UPDATE assist.requests SET status = $2${to === 'completed' ? ', completed_at = now()' : ''} WHERE id = $1`, [id, to]);
      if (to === 'completed') {
        // Pago en efectivo al proveedor: la comisión se descuenta de lo que se le debe.
        const fee = await this.commissions.assist(r.offer_cents, c);
        await c.query(`UPDATE assist.requests SET commission_cents = $2 WHERE id = $1`, [id, fee]);
        if (fee > 0) await postLedger(c, `assist_${r.kind}_commission`, { type: 'assist_request', id }, [{ account: `driver_payable:${providerId}`, debit: fee }, { account: 'platform_revenue', credit: fee }]);
      }
      await this.audit.record({ action: `assist.${to}`, resourceType: 'assist_request', resourceId: id }, req, c);
      return r;
    });
    if (to === 'completed' && done.kind === 'tow') await this.presence.setTrip(providerId, null);
    if (to === 'arrived') await this.notify.notifyUser(done.requester_user_id, 'assist_arrived', { sms: done.kind === 'tow' ? 'Inti Taxi: tu grúa llegó.' : 'Inti Taxi: el vehículo de alquiler llegó al punto de entrega.' });
    return this.view(providerId, id);
  }

  async expire() {
    const r = await this.pool.query(`UPDATE assist.requests SET status = 'expired' WHERE status = 'open' AND expires_at < now()`);
    return r.rowCount ?? 0;
  }
}
