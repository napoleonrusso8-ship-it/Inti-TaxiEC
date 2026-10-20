import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { ReportsService } from './reports.service.js';

const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^<>]*$/);
const category = z.enum(['mistreatment', 'discrimination', 'harassment', 'threats', 'unsafe_driving', 'other']);

@Controller('v1')
@UseGuards(AccessTokenGuard)
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  /** Reportar al conductor (o el conductor al pasajero) por malos tratos. */
  @Post('trips/:id/reports')
  @HttpCode(201)
  create(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ category, description: text(20, 2000), evidenceMediaIds: z.array(z.string().uuid()).max(10).default([]) }), body);
    return this.reports.create(auth.userId, id, i, req);
  }

  @Get('reports')
  mine(@Auth() auth: AuthContext) {
    return this.reports.mine(auth.userId);
  }
}

@Controller('v1/admin')
@UseGuards(AccessTokenGuard, AdminGuard)
@AdminRoles('trust_safety')
export class AdminReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get('reports')
  list(@Query('status') status = 'open') {
    return this.reports.list(parseInput(z.enum(['open', 'investigating', 'resolved', 'dismissed']), status));
  }

  @Get('reports/:id')
  detail(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('reason') reason: unknown) {
    return this.reports.detail(auth.userId, id, parseInput(text(5, 200), reason), req);
  }

  @Post('reports/:id/assign')
  @HttpCode(200)
  @AdminWrite()
  assign(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.assign(auth.userId, id, req);
  }

  @Post('reports/:id/actions')
  @HttpCode(201)
  @AdminWrite()
  action(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ action: z.enum(['contact_reported', 'contact_reporter', 'note']), note: text(5, 1000) }), body);
    return this.reports.addAction(auth.userId, id, i.action, i.note, req);
  }

  @Post('reports/:id/decision')
  @HttpCode(200)
  @AdminWrite()
  decide(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ decision: z.enum(['dismissed', 'warning', 'suspension', 'ban']), days: z.number().int().min(1).max(30).optional(), resolution: text(10, 500) }), body);
    return this.reports.decide(auth.userId, id, i, req);
  }

  @Post('sanctions/:id/approve')
  @HttpCode(200)
  @AdminWrite()
  approve(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.approveSanction(auth.userId, id, req);
  }

  @Post('sanctions/:id/revoke')
  @HttpCode(200)
  @AdminWrite()
  revoke(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ reason: text(10, 500) }), body);
    return this.reports.revokeSanction(auth.userId, id, i.reason, req);
  }
}
