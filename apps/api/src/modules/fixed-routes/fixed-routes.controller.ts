import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, Device, parseInput, type AppRequest, type AttestedDevice } from '@intitaxi/nest-common';
import { z } from 'zod';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { FixedRoutesService } from './fixed-routes.service.js';
import { RoutesAdminService } from './routes-admin.service.js';

const direction = z.enum(['outbound', 'inbound']);
const seats = z.number().int().min(1).max(8);
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^<>]*$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const requireClient = (auth: AuthContext, client: string) => {
  if (auth.clientId !== client) throw new AppError(403, 'forbidden', client === 'intitaxi-driver' ? 'Usa la app de conductor' : 'Usa la app de pasajero');
};

@Controller('v1/routes')
@UseGuards(AccessTokenGuard)
export class RoutesController {
  constructor(@Inject(FixedRoutesService) private readonly routes: FixedRoutesService) {}

  @Get()
  list() {
    return this.routes.listActive();
  }

  @Get('bookings/:id')
  booking(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.routes.bookingView(auth.userId, id);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.routes.cancel(auth.userId, id, req);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.routes.detail(id);
  }

  @Get(':id/vehicles')
  vehicles(@Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const i = parseInput(z.object({ direction, stopId: z.string().uuid().optional() }), q);
    return this.routes.vehicles(id, i.direction, i.stopId);
  }

  @Post(':id/quotes')
  @HttpCode(200)
  quote(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ direction, boardingStopId: z.string().uuid(), alightingStopId: z.string().uuid(), seats }), body);
    return this.routes.quote(id, i);
  }

  /** Reserva: mismos registros de acompañantes que un viaje normal (companions / thirdParty) y validación del pago. */
  @Post(':id/bookings')
  @HttpCode(201)
  @UseGuards(AttestationGuard)
  book(@Req() req: AppRequest, @Auth() auth: AuthContext, @Device() device: AttestedDevice, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireClient(auth, 'intitaxi-passenger');
    const i = parseInput(
      z.object({
        instanceId: z.string().uuid(),
        direction,
        boardingStopId: z.string().uuid(),
        alightingStopId: z.string().uuid(),
        seats,
        paymentMethod: z.enum(['cash', 'card', 'wallet']),
        paymentMethodId: z.string().uuid().optional(),
      }).passthrough(),
      body,
    );
    return this.routes.book(auth.userId, device, id, i, req);
  }
}

@Controller('v1/driver')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class DriverRoutesController {
  constructor(@Inject(FixedRoutesService) private readonly routes: FixedRoutesService) {}

  @Get('routes')
  enabled(@Auth() auth: AuthContext) {
    return this.routes.enabledRoutes(auth.userId);
  }

  @Post('routes/:id/instances')
  @HttpCode(201)
  start(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireClient(auth, 'intitaxi-driver');
    const i = parseInput(z.object({ direction, vehicleId: z.string().uuid() }), body);
    return this.routes.startInstance(auth.userId, id, i.direction, i.vehicleId, req);
  }

  @Get('route-instances/current')
  current(@Auth() auth: AuthContext) {
    return this.routes.currentInstance(auth.userId);
  }

  @Post('route-instances/:id/board')
  @HttpCode(200)
  board(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    requireClient(auth, 'intitaxi-driver');
    const i = parseInput(z.object({ bookingId: z.string().uuid(), pin: z.string().max(8) }), body);
    return this.routes.board(auth.userId, id, i.bookingId, i.pin, req);
  }

  @Post('route-instances/:id/alight')
  @HttpCode(200)
  alight(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ bookingId: z.string().uuid() }), body);
    return this.routes.alight(auth.userId, id, i.bookingId, req);
  }

  @Post('route-instances/:id/finish')
  @HttpCode(200)
  finish(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.routes.finish(auth.userId, id, req);
  }
}

const stopInput = z.object({
  stopId: z.string().uuid().optional(),
  name: text(80),
  reference: text(160).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  locationVerified: z.boolean().optional(),
});
const fareInput = z.object({
  name: text(40),
  startLocal: hhmm,
  endLocal: hhmm,
  amountCents: z.number().int().min(1).max(100_00),
  validFrom: date.optional(),
  validTo: date.optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

@Controller('v1/admin/routes')
@UseGuards(AccessTokenGuard, AdminGuard)
@AdminRoles('route_manager')
export class AdminRoutesController {
  constructor(@Inject(RoutesAdminService) private readonly admin: RoutesAdminService) {}

  @Get()
  list() {
    return this.admin.list();
  }

  @Post()
  @HttpCode(201)
  @AdminWrite()
  create(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ code: z.string().regex(/^R\d{1,3}$/), name: text(120), corridor: text(300).optional() }), body);
    return this.admin.create(auth.userId, i, req);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.detail(id);
  }

  @Put(':id/directions/:direction/stops')
  @AdminWrite()
  stops(@Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string, @Param('direction') dir: string, @Body() body: unknown) {
    const d = parseInput(direction, dir);
    const i = parseInput(z.object({ label: text(80).optional(), stops: z.array(stopInput).min(2).max(60) }), body);
    return this.admin.setStops(id, d, i, req);
  }

  @Put(':id/fares')
  @AdminWrite()
  fares(@Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ rules: z.array(fareInput).min(1).max(24) }), body);
    return this.admin.setFares(id, i.rules, req);
  }

  @Put(':id/schedules')
  @AdminWrite()
  schedules(@Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(
      z.object({ schedules: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hhmm, end: hhmm, headwayMinutes: z.number().int().min(1).max(180) })).max(14) }),
      body,
    );
    return this.admin.setSchedules(id, i.schedules, req);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @AdminWrite()
  validate(@Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.validate(id, req);
  }

  @Post(':id/publish-request')
  @HttpCode(200)
  @AdminWrite()
  requestPublish(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.requestPublish(auth.userId, id, req);
  }

  @Post(':id/publish-decision')
  @HttpCode(200)
  @AdminWrite()
  decide(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ approve: z.boolean() }), body);
    return this.admin.approvePublish(auth.userId, id, i.approve, req);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @AdminWrite()
  pause(@Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ reason: text(300) }), body);
    return this.admin.pause(id, i.reason, req);
  }

  @Get(':id/drivers')
  drivers(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.enablements(id);
  }

  @Post(':id/drivers')
  @HttpCode(200)
  @AdminWrite()
  enable(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ driverId: z.string().uuid() }), body);
    return this.admin.enable(auth.userId, id, i.driverId, req);
  }

  @Delete(':id/drivers/:driverId')
  @AdminWrite()
  disable(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('driverId', ParseUUIDPipe) driverId: string) {
    return this.admin.disable(auth.userId, id, driverId, req);
  }
}
