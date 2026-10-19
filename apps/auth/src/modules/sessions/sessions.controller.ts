import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuditService, AppError, AccessTokenGuard, Auth, type AppRequest } from '@intitaxi/nest-common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { PG_POOL } from '../../tokens.js';
import { TokenService } from '../tokens/token.service.js';

@Controller('v1/auth')
@UseGuards(AccessTokenGuard)
export class SessionsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Sesiones activas del propio usuario (la consulta filtra siempre por user_id del token). */
  @Get('sessions')
  async list(@Auth() auth: AuthContext) {
    const { rows } = await this.pool.query<{ id: string; platform: string; client_id: string; created_at: Date; last_rotated_at: Date; acr: string }>(
      `SELECT s.id, d.platform, s.client_id, s.created_at, s.last_rotated_at, s.acr
       FROM identity.sessions s JOIN identity.devices d ON d.id = s.device_id
       WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
       ORDER BY s.last_rotated_at DESC LIMIT 50`,
      [auth.userId],
    );
    return rows.map((r) => ({ id: r.id, platform: r.platform, app: r.client_id, createdAt: r.created_at, lastActiveAt: r.last_rotated_at, current: r.id === auth.sessionId }));
  }

  /** Cierra una sesión propia. Una sesión ajena responde 404 igual que una inexistente (anti-IDOR/enumeración). */
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const ok = await this.tokens.revokeSession(auth.userId, id, 'user_revoked');
    await this.audit.record({ action: 'session.revoke', resourceType: 'session', resourceId: id, outcome: ok ? 'success' : 'denied' }, req);
    if (!ok) throw new AppError(404, 'not_found', 'Recurso no encontrado');
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    await this.tokens.revokeSession(auth.userId, auth.sessionId, 'logout');
    await this.audit.record({ action: 'session.logout', resourceType: 'session', resourceId: auth.sessionId }, req);
  }
}
