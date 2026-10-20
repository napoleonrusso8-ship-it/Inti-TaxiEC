import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { TripPrefs } from '../trips/trips.controller.js';
import { CommunityService } from './community.service.js';
import { SafetyMonitorService } from './safety-monitor.service.js';

const role = (auth: AuthContext) => (auth.clientId === 'intitaxi-driver' ? 'driver' : 'passenger') as 'driver' | 'passenger';

@Controller('v1')
@UseGuards(AccessTokenGuard)
export class CommunityController {
  constructor(
    @Inject(CommunityService) private readonly community: CommunityService,
    @Inject(SafetyMonitorService) private readonly monitor: SafetyMonitorService,
  ) {}

  @Get('me/preferences')
  preferences(@Auth() auth: AuthContext) {
    return this.community.preferences(auth.userId);
  }

  /** Nombre de preferencia, Modo Ellxs (autodeclaración con consentimiento), alerta de desvío y preferencias por defecto. */
  @Put('me/preferences')
  setPreferences(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(
      z.object({
        chosenName: z.string().trim().min(2).max(40).regex(/^[\p{L} '.-]+$/u).nullable().optional(),
        ellxsMember: z.boolean().optional(),
        deviationAlerts: z.enum(['night', 'always', 'off']).optional(),
        defaultPrefs: TripPrefs.optional(),
      }).strict(),
      body,
    );
    return this.community.setPreferences(auth.userId, i, req);
  }

  @Get('loyalty')
  loyalty(@Auth() auth: AuthContext) {
    return this.community.loyalty(auth.userId, role(auth));
  }

  @Post('loyalty/redeem')
  @HttpCode(200)
  redeem(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    return this.community.redeem(auth.userId, role(auth), parseInput(z.object({ points: z.number().int().positive() }), body).points, req);
  }

  /** Comprobación de seguridad pendiente (desvío / parada larga) para el pasajero. */
  @Get('trips/:id/safety-checks/pending')
  pendingCheck(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.monitor.pending(auth.userId, id);
  }

  @Post('trips/:id/safety-checks/:checkId')
  @HttpCode(200)
  respond(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('checkId', ParseUUIDPipe) checkId: string, @Body() body: unknown) {
    return this.monitor.respond(auth.userId, id, checkId, parseInput(z.object({ ok: z.boolean() }), body).ok, req);
  }
}

@Controller('v1/driver')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class DriverCommunityController {
  constructor(@Inject(CommunityService) private readonly community: CommunityService) {}

  @Post('ellxs/request')
  @HttpCode(200)
  ellxs(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    if (auth.clientId !== 'intitaxi-driver') throw new AppError(403, 'forbidden', 'Usa la app de conductor');
    return this.community.requestEllxs(auth.userId, req);
  }

  @Get('ally/course')
  course() {
    return this.community.allyCourse();
  }

  @Post('ally/certify')
  @HttpCode(200)
  certify(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    return this.community.certifyAlly(auth.userId, parseInput(z.object({ answers: z.record(z.string().max(8), z.number().int().min(0).max(5)) }), body).answers, req);
  }

  @Put('vehicles/:id/features')
  features(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ features: z.array(z.enum(['ac', 'pet_friendly', 'wheelchair', 'large_luggage'])).max(4) }), body);
    return this.community.setVehicleFeatures(auth.userId, id, i.features, req);
  }
}

@Controller('v1/admin/drivers')
@UseGuards(AccessTokenGuard, AdminGuard)
@AdminRoles('driver_reviewer')
export class AdminCommunityController {
  constructor(@Inject(CommunityService) private readonly community: CommunityService) {}

  @Get('ellxs/pending')
  async pendingEllxs() {
    return this.community.pendingEllxs();
  }

  @Post(':id/ellxs')
  @HttpCode(200)
  @AdminWrite()
  decide(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.community.approveEllxs(auth.userId, id, parseInput(z.object({ approve: z.boolean() }), body).approve, req);
  }
}
