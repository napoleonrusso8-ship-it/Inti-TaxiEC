import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { AccessTokenGuard, AppError, Auth, AuditService, parseInput, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { AdminGuard, AdminRoles, AdminWrite } from './admin.guard.js';

const Role = z.enum(['super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo']);

@Controller('v1/admin')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminRolesController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('me')
  @AdminRoles('super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo')
  me(@Req() req: AppRequest & { adminRoles?: string[] }, @Auth() auth: AuthContext) {
    return { userId: auth.userId, roles: req.adminRoles };
  }

  @Get('users/:id/roles')
  @AdminRoles('super_admin')
  async list(@Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await this.pool.query('SELECT id, role, granted_by, granted_at, expires_at FROM admin.role_assignments WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    return rows;
  }

  /** Solo super_admin; nadie puede asignarse roles a sí mismo. */
  @Post('users/:id/roles')
  @HttpCode(201)
  @AdminRoles('super_admin')
  @AdminWrite()
  async grant(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { role, expiresInDays } = parseInput(z.object({ role: Role, expiresInDays: z.number().int().min(1).max(365).optional() }), body);
    if (id === auth.userId) throw new AppError(403, 'forbidden', 'No puedes asignarte roles a ti mismo');
    await this.pool.query(
      `INSERT INTO admin.role_assignments (id, user_id, role, granted_by, expires_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
       ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING`,
      [randomUUID(), id, role, auth.userId, expiresInDays ?? null],
    );
    await this.audit.record({ action: 'admin.role_grant', resourceType: 'user', resourceId: id, actorRole: 'super_admin', metadata: { role } }, req);
    return { userId: id, role };
  }

  @Delete('users/:id/roles/:role')
  @HttpCode(204)
  @AdminRoles('super_admin')
  @AdminWrite()
  async revoke(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('role') role: string) {
    const r = parseInput(Role, role);
    await this.pool.query('UPDATE admin.role_assignments SET revoked_at = now(), revoked_by = $3 WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL', [id, r, auth.userId]);
    await this.audit.record({ action: 'admin.role_revoke', resourceType: 'user', resourceId: id, actorRole: 'super_admin', metadata: { role: r } }, req);
  }
}

/** SOLO DESARROLLO: concede un rol sin aprobación para el simulador. En producción el primer super_admin se crea con la CLI auditada. */
@Controller('v1/dev/admin')
export class DevAdminController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post('grant')
  @HttpCode(201)
  async grant(@Body() body: unknown) {
    const { userId, role } = parseInput(z.object({ userId: z.string().uuid(), role: Role }), body);
    await this.pool.query(
      `INSERT INTO admin.role_assignments (id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, role) WHERE revoked_at IS NULL DO NOTHING`,
      [randomUUID(), userId, role],
    );
    return { userId, role };
  }
}
