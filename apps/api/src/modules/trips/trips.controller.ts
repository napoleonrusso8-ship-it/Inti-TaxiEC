import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, AuditService, Device, parseInput, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { DriversService } from '../drivers/drivers.service.js';
import { KycService } from '../kyc/kyc.service.js';
import { FraudService } from '../payments/fraud.service.js';
import { MatchingService } from './matching.service.js';
import { PresenceService, type VehicleKind } from './presence.service.js';
import { TripsService } from './trips.service.js';

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const label = z.string().max(160).regex(/^[^<>]*$/).optional();
const idempotencyKey = (req: AppRequest) => {
  const k = req.header('idempotency-key');
  if (!k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) throw new AppError(400, 'idempotency_key_required', 'Falta la cabecera Idempotency-Key');
  return k;
};
const requireClient = (auth: AuthContext, client: string) => {
  if (auth.clientId !== client) throw new AppError(403, 'forbidden', client === 'intitaxi-driver' ? 'Usa la app de conductor' : 'Usa la app de pasajero');
};

@Controller('v1/trips')
@UseGuards(AccessTokenGuard)
export class TripsController {
  constructor(@Inject(TripsService) private readonly trips: TripsService) {}

  @Post('quotes')
  @HttpCode(200)
  quote(@Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ origin: point, destination: point, originLabel: label, destinationLabel: label }), body);
    return this.trips.quote(auth.userId, i);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(AttestationGuard)
  request(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Body() body: unknown) {
    requireClient(auth, 'intitaxi-passenger');
    const i = parseInput(
      z.object({ quoteId: z.string().max(64), paymentMethod: z.enum(['cash', 'card', 'wallet']), paymentMethodId: z.string().uuid().optional() }).passthrough(),
      body,
    );
    return this.trips.request(auth.userId, device, { ...i, idempotencyKey: idempotencyKey(req) }, req);
  }

  @Get()
  history(@Auth() auth: AuthContext) {
    return this.trips.history(auth.userId, auth.clientId === 'intitaxi-driver');
  }

  /** Mis etiquetas recibidas (positivas y de mejora), agregadas y anónimas. */
  @Get('me/feedback')
  feedback(@Auth() auth: AuthContext) {
    return this.trips.myFeedback(auth.userId);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.viewFor(auth.userId, id);
  }

  @Get(':id/pin')
  pin(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.pin(auth.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseInput(z.object({ reason: z.string().max(200).optional() }), body ?? {});
    return this.trips.cancel(auth.userId, id, reason, req);
  }

  @Post(':id/rating')
  @HttpCode(201)
  rate(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { stars, comment, tags } = parseInput(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(6).default([]) }), body);
    return this.trips.rate(auth.userId, id, stars, comment, req, tags);
  }

  /** "Pedir otra unidad" (máximo 5 por viaje; el sexto intento cierra la carrera). */
  @Post(':id/reassign')
  @HttpCode(200)
  reassign(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason } = parseInput(z.object({ reason: z.string().max(200).regex(/^[^<>]*$/).optional() }), body ?? {});
    return this.trips.reassign(auth.userId, id, reason, req);
  }

  @Post(':id/contact-session')
  @HttpCode(201)
  contact(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.contactSession(auth.userId, id, req);
  }
}

@Controller('v1/driver')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class DriverTripsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(MatchingService) private readonly matching: MatchingService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(DriversService) private readonly drivers: DriversService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FraudService) private readonly fraud: FraudService,
  ) {}

  /** Conectarse: conductor aprobado, documentos vigentes, identidad fresca (re-verificación) y vehículo propio aprobado. */
  @Post('online')
  @HttpCode(200)
  async online(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Body() body: unknown) {
    requireClient(auth, 'intitaxi-driver');
    const i = parseInput(z.object({ vehicleId: z.string().uuid(), location: point, mock: z.boolean().default(false) }), body);
    const issues = await this.drivers.eligibility(auth.userId);
    if (issues.length) throw new AppError(403, 'not_eligible', `No puedes conectarte: ${issues.join(', ')}`);
    await this.kyc.assertDriverIdentityFresh(auth.userId);
    const v = await this.pool.query<{ seats_passenger: number; vehicle_type: VehicleKind }>(`SELECT seats_passenger, vehicle_type FROM drivers.vehicles WHERE id = $1 AND driver_id = $2 AND status = 'approved'`, [i.vehicleId, auth.userId]);
    if (!v.rows[0]) throw new AppError(404, 'not_found', 'Vehículo no encontrado o no aprobado');
    if (v.rows[0].vehicle_type === 'rental') throw new AppError(409, 'not_drivable_service', 'Los vehículos de alquiler no se conectan: recibes las solicitudes en la sección Alquiler');
    await this.pool.query('UPDATE drivers.online_sessions SET ended_at = now() WHERE driver_id = $1 AND ended_at IS NULL', [auth.userId]);
    const sessionId = randomUUID();
    await this.pool.query('INSERT INTO drivers.online_sessions (id, driver_id, vehicle_id, device_id) VALUES ($1, $2, $3, $4)', [sessionId, auth.userId, i.vehicleId, device.deviceId]);
    await this.presence.goOnline(auth.userId, { vehicleId: i.vehicleId, seats: v.rows[0].seats_passenger, sessionId, vehicleType: v.rows[0].vehicle_type }, { ...i.location, at: Date.now() });
    await this.fraud.onDeviceUse(device.deviceId, auth.userId);
    await this.audit.record({ action: 'driver.online', resourceType: 'driver', resourceId: auth.userId, metadata: { vehicleId: i.vehicleId } }, req);
    return { online: true, sessionId };
  }

  @Post('offline')
  @HttpCode(200)
  async offline(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    const st = await this.presence.state(auth.userId);
    if (st?.tripId) throw new AppError(409, 'on_trip', 'Termina el viaje en curso antes de desconectarte');
    await this.presence.goOffline(auth.userId);
    await this.pool.query('UPDATE drivers.online_sessions SET ended_at = now() WHERE driver_id = $1 AND ended_at IS NULL', [auth.userId]);
    await this.audit.record({ action: 'driver.offline', resourceType: 'driver', resourceId: auth.userId }, req);
    return { online: false };
  }

  @Post('location')
  @HttpCode(200)
  async location(@Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ location: point, heading: z.number().min(0).max(360).optional(), speed: z.number().min(0).max(100).optional(), mock: z.boolean().default(false) }), body);
    const st = await this.presence.state(auth.userId);
    if (!st) throw new AppError(409, 'offline', 'No estás conectado');
    return this.presence.updateLocation(auth.userId, { ...i.location, heading: i.heading, speed: i.speed, at: Date.now() }, { available: !st.tripId, clientMock: i.mock });
  }

  @Get('offers')
  offers(@Auth() auth: AuthContext) {
    return this.matching.offersFor(auth.userId);
  }

  @Post('offers/:id/accept')
  @HttpCode(200)
  accept(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    requireClient(auth, 'intitaxi-driver');
    return this.matching.accept(auth.userId, id, req);
  }

  @Post('offers/:id/reject')
  @HttpCode(200)
  reject(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.reject(auth.userId, id);
  }

  @Get('trips/current')
  async current(@Auth() auth: AuthContext) {
    const st = await this.presence.state(auth.userId);
    if (st?.tripId?.startsWith('route:')) return { routeInstanceId: st.tripId.slice(6) };
    return st?.tripId ? this.trips.viewFor(auth.userId, st.tripId) : null;
  }

  @Post('trips/:id/arrived')
  @HttpCode(200)
  arrived(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.arrived(auth.userId, id, req);
  }

  @Post('trips/:id/start')
  @HttpCode(200)
  start(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { pin } = parseInput(z.object({ pin: z.string().max(8) }), body);
    return this.trips.start(auth.userId, id, pin, req);
  }

  @Post('trips/:id/complete')
  @HttpCode(200)
  complete(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.trips.complete(auth.userId, id, req);
  }
}
