import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { AccessTokenGuard, Auth, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { z } from 'zod';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { BackofficeService } from './backoffice.service.js';
import { DisputesService } from './disputes.service.js';

const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^<>]*$/);
const ALL_ROLES = ['super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo'] as const;

/** Reclamos de usuarios (pasajero o conductor del viaje). */
@Controller('v1')
@UseGuards(AccessTokenGuard)
export class DisputesController {
  constructor(@Inject(DisputesService) private readonly disputes: DisputesService) {}

  @Post('trips/:id/disputes')
  @HttpCode(201)
  open(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ category: z.enum(['fare', 'route', 'conduct', 'lost_item', 'safety', 'other']), description: text(10, 2000) }), body);
    return this.disputes.open(auth.userId, id, i, req);
  }

  @Get('disputes')
  mine(@Auth() auth: AuthContext) {
    return this.disputes.mine(auth.userId);
  }
}

@Controller('v1/admin')
@UseGuards(AccessTokenGuard, AdminGuard)
export class BackofficeController {
  constructor(
    @Inject(BackofficeService) private readonly bo: BackofficeService,
    @Inject(DisputesService) private readonly disputes: DisputesService,
  ) {}

  @Get('metrics')
  @AdminRoles(...ALL_ROLES)
  metrics() {
    return this.bo.metrics();
  }

  // ----- Disputas (support) -----

  @Get('disputes')
  @AdminRoles('support')
  listDisputes(@Query('status') status = 'open') {
    return this.disputes.list(parseInput(z.enum(['open', 'in_review', 'resolved', 'rejected']), status));
  }

  @Get('disputes/:id')
  @AdminRoles('support')
  dispute(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('reason') reason: unknown) {
    return this.disputes.detail(auth.userId, id, parseInput(text(5, 200), reason), req);
  }

  @Post('disputes/:id/assign')
  @HttpCode(200)
  @AdminRoles('support')
  @AdminWrite()
  assign(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.assign(auth.userId, id, req);
  }

  @Post('disputes/:id/resolve')
  @HttpCode(200)
  @AdminRoles('support')
  @AdminWrite()
  resolve(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(
      z.object({ decision: z.enum(['resolved', 'rejected']), resolution: text(5, 500), refundCents: z.number().int().positive().max(100_00).optional(), refundTo: z.enum(['original', 'wallet']).optional() }),
      body,
    );
    return this.disputes.resolve(auth.userId, id, i, req);
  }

  // ----- Auditoría (auditor: solo lectura) -----

  @Get('audit')
  @AdminRoles('auditor')
  auditLog(@Query() q: unknown) {
    const f = parseInput(
      z.object({
        action: z.string().max(60).regex(/^[a-z0-9_.]*$/).optional(),
        resourceType: z.string().max(40).regex(/^[a-z0-9_]*$/).optional(),
        resourceId: z.string().max(80).optional(),
        actorUserId: z.string().uuid().optional(),
        outcome: z.enum(['success', 'denied', 'failure']).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      q,
    );
    return this.bo.auditLog(f);
  }

  @Post('audit/verify')
  @HttpCode(200)
  @AdminRoles('auditor')
  verify(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    return this.bo.verifyAudit(auth.userId, req);
  }

  // ----- Privacidad (dpo) -----

  @Get('privacy-requests')
  @AdminRoles('dpo')
  privacy(@Query('status') status = 'received') {
    return this.bo.privacyRequests(parseInput(z.enum(['received', 'deferred_legal_hold', 'completed', 'rejected']), status));
  }

  @Post('privacy-requests/:id/decision')
  @HttpCode(200)
  @AdminRoles('dpo')
  @AdminWrite()
  decidePrivacy(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ decision: z.enum(['complete', 'reject']), notes: text(5, 500) }), body);
    return this.bo.decidePrivacy(auth.userId, id, i.decision, i.notes, req);
  }

  // ----- KYC duplicados (fraud_analyst) -----

  @Get('kyc/reviews')
  @AdminRoles('fraud_analyst')
  kycReviews() {
    return this.bo.kycReviews();
  }

  @Post('kyc/reviews/:id/decision')
  @HttpCode(200)
  @AdminRoles('fraud_analyst')
  @AdminWrite()
  decideKyc(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ decision: z.enum(['reject', 'transfer']), reason: text(5, 300) }), body);
    return this.bo.decideKyc(auth.userId, id, i.decision, i.reason, req);
  }
}
