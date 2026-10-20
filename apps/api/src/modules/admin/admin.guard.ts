import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertRecentMfa } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { AppError, type AppRequest } from '@intitaxi/nest-common';
import { PG_POOL } from '../../tokens.js';

export type AdminRole = 'super_admin' | 'driver_reviewer' | 'support' | 'fraud_analyst' | 'sos_operator' | 'route_manager' | 'auditor' | 'dpo' | 'trust_safety';
export const ADMIN_CLIENT = 'intitaxi-admin';

const ROLES_KEY = 'intitaxi:admin-roles';
const WRITE_KEY = 'intitaxi:admin-write';

/** Roles que pueden acceder (super_admin siempre puede). */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
/** Acción de escritura: exige passkey reciente (≤ 15 min). */
export const AdminWrite = () => SetMetadata(WRITE_KEY, true);

export type AdminRequest = AppRequest & { adminRoles?: AdminRole[] };

/**
 * RBAC del panel. Debe ir después de AccessTokenGuard. Exige:
 *  - token del cliente "intitaxi-admin" (obtenido solo con passkey);
 *  - un rol activo en admin.role_assignments (fuente de verdad: revocar un rol surte efecto en la siguiente petición);
 *  - para escrituras, passkey verificada hace ≤ 15 min.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const auth = req.auth!;
    const deny = () => new AppError(403, 'forbidden', 'No tienes permiso para esta acción');
    if (auth.clientId !== ADMIN_CLIENT) throw deny();
    const needed = this.reflector.getAllAndOverride<AdminRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const { rows } = await this.pool.query<{ role: AdminRole }>(
      `SELECT role FROM admin.role_assignments WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [auth.userId],
    );
    const roles = rows.map((r) => r.role);
    if (!roles.includes('super_admin') && !needed.some((r) => roles.includes(r))) throw deny();
    const write = this.reflector.getAllAndOverride<boolean>(WRITE_KEY, [ctx.getHandler(), ctx.getClass()]) ?? false;
    assertRecentMfa(auth, { phishingResistant: true, maxAgeSeconds: write ? 900 : 8 * 3600 });
    req.adminRoles = roles;
    return true;
  }
}
