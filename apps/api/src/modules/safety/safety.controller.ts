import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import type { Pool } from '@intitaxi/db';
import { AccessTokenGuard, AppError, AttestationGuard, Auth, AuditService, parseInput, RateLimiter, REDIS, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { PG_POOL } from '../../tokens.js';
import { AdminGuard, AdminRoles, AdminWrite } from '../admin/admin.guard.js';
import { ManifestService } from './manifest.service.js';
import { SosService } from './sos.service.js';

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const pin = z.string().regex(/^\d{4,6}$/);

@Controller('v1')
export class SosController {
  constructor(
    @Inject(SosService) private readonly sos: SosService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  /** El SOS nunca se bloquea por límites ni por atestación: basta un token válido de un participante del viaje. */
  @Post('sos')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  async activate(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ tripId: z.string().uuid(), location: point.optional() }), body);
    const role = await this.sos.userRole(auth.userId, i.tripId);
    if (!role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    return this.sos.activate(i.tripId, { kind: 'user', userId: auth.userId, role }, 'sos', i.location ?? null, req);
  }

  @Get('sos/:id')
  @UseGuards(AccessTokenGuard)
  status(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.status(id, { kind: 'user', userId: auth.userId, role: 'passenger' });
  }

  @Post('sos/:id/location')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  location(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { location } = parseInput(z.object({ location: point }), body);
    return this.sos.location(id, { kind: 'user', userId: auth.userId, role: 'passenger' }, location);
  }

  /** Fragmentos de audio (cuerpo binario, ≤ 256 KB) del teléfono del activador, si dio su consentimiento. */
  @Post('sos/:id/audio')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  audio(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('seq') seq: string) {
    const ct = req.header('content-type') ?? '';
    if (!/^audio\/(aac|mp4|webm|ogg)$/.test(ct) || !Buffer.isBuffer(req.body)) throw new AppError(415, 'unsupported_media_type', 'Formato de audio no admitido');
    return this.sos.audio(id, auth, parseInput(z.coerce.number().int().min(0).max(100_000), seq), ct, req.body);
  }

  @Post('sos/:id/cancel')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  cancel(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.sos.cancel(id, auth, parseInput(z.object({ pin }), body).pin, req);
  }

  @Put('me/safety-pins')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  pins(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ pin, duressPin: pin, currentPin: pin.optional() }), body);
    return this.sos.setPins(auth.userId, i.pin, i.duressPin, i.currentPin, req);
  }

  /** Acompañantes y terceros sin app: SOS desde su enlace de seguimiento. */
  @Post('track/:token/sos')
  @HttpCode(201)
  async linkSos(@Req() req: AppRequest, @Param('token') token: string, @Body() body: unknown) {
    const rl = await this.limiter.hit(`link-sos:${req.ip}`, 20, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const tripId = await this.sos.tripFromLink(token);
    if (!tripId) throw new AppError(404, 'not_found', 'Enlace inválido o vencido');
    const { location } = parseInput(z.object({ location: point.optional() }), body ?? {});
    return this.sos.activate(tripId, { kind: 'link', tripId }, 'sos', location ?? null, req);
  }

  @Post('driver/trips/:id/accident')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  async accident(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    if ((await this.sos.userRole(auth.userId, id)) !== 'driver') throw new AppError(404, 'not_found', 'Recurso no encontrado');
    const { location } = parseInput(z.object({ location: point.optional() }), body ?? {});
    return this.sos.activate(id, { kind: 'user', userId: auth.userId, role: 'driver' }, 'accident', location ?? null, req);
  }
}

@Controller('v1/admin')
@UseGuards(AccessTokenGuard, AdminGuard)
export class AdminSafetyController {
  constructor(
    @Inject(SosService) private readonly sos: SosService,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('incidents')
  @AdminRoles('sos_operator', 'auditor')
  list(@Query('status') status = 'active') {
    return this.sos.list(parseInput(z.enum(['active', 'cancelled_by_user', 'closed']), status));
  }

  @Get('incidents/:id')
  @AdminRoles('sos_operator')
  detail(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.detail(id, auth.userId, req);
  }

  @Post('incidents/:id/acknowledge')
  @HttpCode(200)
  @AdminRoles('sos_operator')
  ack(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.acknowledge(id, auth.userId, req);
  }

  @Post('incidents/:id/escalate')
  @HttpCode(200)
  @AdminRoles('sos_operator')
  escalate(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.escalate(id, auth.userId, req);
  }

  @Post('incidents/:id/close')
  @HttpCode(200)
  @AdminRoles('sos_operator')
  @AdminWrite()
  close(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const i = parseInput(z.object({ resolution: z.string().min(5).max(500), legalHoldDays: z.number().int().min(0).max(3650).default(0) }), body);
    return this.sos.close(id, auth.userId, i.resolution, i.legalHoldDays, req);
  }

  /** El DPO libera la retención legal de un viaje cuando ya no es necesaria (vuelve a la retención normal). */
  @Post('trips/:id/release-hold')
  @HttpCode(200)
  @AdminRoles('dpo')
  @AdminWrite()
  async release(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const open = await this.pool.query(`SELECT 1 FROM safety.incidents WHERE trip_id = $1 AND (status IN ('open', 'acknowledged', 'escalated') OR legal_hold_until > now())`, [id]);
    if (open.rowCount) throw new AppError(409, 'hold_active', 'Hay un incidente abierto o una retención legal vigente');
    await this.pool.query('UPDATE trips.trips SET incident_hold = false WHERE id = $1', [id]);
    await this.audit.record({ action: 'trip.hold_released', resourceType: 'trip', resourceId: id, actorUserId: auth.userId, actorRole: 'dpo' }, req);
    return { tripId: id, incidentHold: false };
  }

  @Post('trips/:id/accident')
  @HttpCode(201)
  @AdminRoles('sos_operator')
  accident(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.activate(id, { kind: 'operator', userId: auth.userId }, 'accident', null, req);
  }

  /** Ver un manifiesto fuera de un incidente (soporte/auditoría): motivo obligatorio y auditado. */
  @Get('trips/:id/manifest')
  @AdminRoles('support', 'auditor', 'sos_operator')
  async manifest(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('reason') reason = '') {
    if (reason.length < 10) throw new AppError(400, 'reason_required', 'Indica el motivo (mín. 10 caracteres)');
    await this.audit.record({ action: 'manifest.view', resourceType: 'trip', resourceId: id, actorUserId: auth.userId, purpose: 'admin_review', metadata: { reason } }, req);
    const m = await this.manifests.latest(id);
    if (!m) throw new AppError(404, 'not_found', 'Sin manifiesto');
    return m;
  }

  @Post('authority-disclosures')
  @HttpCode(201)
  @AdminRoles('sos_operator', 'dpo')
  @AdminWrite()
  request(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ tripId: z.string().uuid(), incidentId: z.string().uuid().optional(), authority: z.string().min(3).max(120), legalBasis: z.string().min(10).max(300) }), body);
    return this.sos.requestDisclosure(auth.userId, i.tripId, i.incidentId ?? null, i.authority, i.legalBasis, req);
  }

  @Post('authority-disclosures/:id/approve')
  @HttpCode(200)
  @AdminRoles('dpo')
  @AdminWrite()
  approve(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sos.approveDisclosure(auth.userId, id, req);
  }
}

@Controller('v1')
export class AuthorityController {
  constructor(
    @Inject(SosService) private readonly sos: SosService,
    @Inject(ManifestService) private readonly manifests: ManifestService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get('authority/manifest/:token')
  async view(@Req() req: AppRequest, @Param('token') token: string) {
    const rl = await this.limiter.hit(`authority-ip:${req.ip}`, 30, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    return this.sos.authorityView(token, req);
  }

  /** Clave pública para verificar la firma de los manifiestos. */
  @Get('manifest/public-key')
  publicKey() {
    return { algorithm: 'ES256', publicKeyPem: this.manifests.publicKeyPem() };
  }
}

/** SOLO DESARROLLO: lo que "recibió" el ECU 911 simulado (nunca se contacta al 911 real). */
@Controller('v1/dev/ecu911')
export class DevEcu911Controller {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  @Get()
  async log() {
    return (await this.redis.lrange('ecu911:mock', 0, 49)).map((x) => JSON.parse(x));
  }
}
