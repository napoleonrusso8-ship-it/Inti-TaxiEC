import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { AssistService } from './assist.service.js';

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const label = z.string().max(160).regex(/^[^<>]*$/).optional();
const towCategory = z.enum(['moto', 'auto', 'camioneta', 'pesado']);
const rentalCategory = z.enum(['auto', 'suv', 'camioneta', 'furgoneta']);
const offer = z.number().int().min(100).max(500_000);

const TowRequest = z.object({
  kind: z.literal('tow'),
  pickup: point,
  destination: point,
  pickupLabel: label,
  destinationLabel: label,
  vehicleCategory: towCategory,
  problem: z.enum(['no_enciende', 'choque', 'llanta', 'sin_combustible', 'otro']),
  notes: z.string().max(500).regex(/^[^<>]*$/).optional(),
  offerCents: offer,
});
const RentalRequest = z.object({
  kind: z.literal('rental'),
  pickup: point,
  pickupLabel: label,
  vehicleCategory: rentalCategory,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(30),
  notes: z.string().max(500).regex(/^[^<>]*$/).optional(),
  offerCents: offer,
});

/** Grúas y alquiler: lado del usuario. */
@Controller('v1/assist')
@UseGuards(AccessTokenGuard)
export class AssistController {
  constructor(@Inject(AssistService) private readonly assist: AssistService) {}

  @Post('suggest')
  @HttpCode(200)
  suggest(@Body() body: unknown) {
    const i = parseInput(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('tow'), pickup: point, destination: point, vehicleCategory: towCategory }),
        z.object({ kind: z.literal('rental'), vehicleCategory: rentalCategory, days: z.number().int().min(1).max(30) }),
      ]),
      body,
    );
    return this.assist.suggest(i);
  }

  @Post('requests')
  @HttpCode(201)
  @UseGuards(AttestationGuard)
  create(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    if (auth.clientId !== 'intitaxi-passenger') throw new AppError(403, 'forbidden', 'Usa la app de pasajero');
    return this.assist.create(auth.userId, parseInput(z.discriminatedUnion('kind', [TowRequest, RentalRequest]), body), req);
  }

  @Get('requests/:id')
  view(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assist.view(auth.userId, id);
  }

  @Post('requests/:id/raise')
  @HttpCode(200)
  raise(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.assist.raise(auth.userId, id, parseInput(z.object({ offerCents: offer }), body).offerCents, req);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.assist.cancel(auth.userId, id, parseInput(z.object({ reason: z.string().max(200).regex(/^[^<>]*$/).optional() }), body ?? {}).reason, req);
  }

  @Post('requests/:id/rating')
  @HttpCode(200)
  rate(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.assist.rate(auth.userId, id, parseInput(z.object({ stars: z.number().int().min(1).max(5) }), body).stars, req);
  }
}

/** Lado del proveedor (grúas y vehículos de alquiler), desde la app de conductor. */
@Controller('v1/provider/assist')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class ProviderAssistController {
  constructor(@Inject(AssistService) private readonly assist: AssistService) {}

  @Get('requests')
  open(@Auth() auth: AuthContext, @Query('kind') kind: unknown) {
    return this.assist.openFor(auth.userId, parseInput(z.enum(['tow', 'rental']), kind));
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  accept(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    if (auth.clientId !== 'intitaxi-driver') throw new AppError(403, 'forbidden', 'Usa la app de conductor');
    return this.assist.accept(auth.userId, id, parseInput(z.object({ vehicleId: z.string().uuid() }), body).vehicleId, req);
  }

  @Post('requests/:id/:step')
  @HttpCode(200)
  step(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('step') step: string) {
    return this.assist.progress(auth.userId, id, parseInput(z.enum(['arrived', 'in_progress', 'completed']), step), req);
  }
}
