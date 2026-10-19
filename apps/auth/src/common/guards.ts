import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AccessTokenVerifier, assertRecentMfa, type AuthContext, verifyDpopProof } from '@intitaxi/auth-verifier';
import { sha256Base64Url } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { RedisDpopReplayStore } from '../infra/redis-stores.js';
import { CONFIG, REDIS } from '../tokens.js';
import { AppError } from './errors.js';
import { publicUrl, type AppRequest, type AttestedDevice } from './request.js';

/** Exige token de acceso DPoP válido. */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(AccessTokenVerifier) private readonly verifier: AccessTokenVerifier,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    req.auth = await this.verifier.verify({
      authorization: req.header('authorization'),
      dpop: req.header('dpop'),
      method: req.method,
      url: publicUrl(this.config.PUBLIC_BASE_URL, req),
    });
    return true;
  }
}

/** Exige solo una prueba DPoP (endpoints previos al login). Liga el flujo a la clave del dispositivo. */
@Injectable()
export class DpopProofGuard implements CanActivate {
  constructor(
    @Inject(RedisDpopReplayStore) private readonly replay: RedisDpopReplayStore,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const { jkt } = await verifyDpopProof({
      proof: req.header('dpop'),
      method: req.method,
      url: publicUrl(this.config.PUBLIC_BASE_URL, req),
      replayStore: this.replay,
    });
    req.dpop = { jkt };
    return true;
  }
}

export const ATTESTATION_TICKET_TTL = 10 * 60;
export const attestationTicketKey = (ticket: string) => `att:ticket:${sha256Base64Url(ticket)}`;

/**
 * Exige un ticket de atestación vigente (Play Integrity / App Attest verificado en el servidor)
 * emitido para la MISMA clave DPoP que firma la petición. Debe ir después de AccessTokenGuard o DpopProofGuard.
 */
@Injectable()
export class AttestationGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const ticket = req.header('x-attestation-ticket');
    const jkt = req.auth?.jkt ?? req.dpop?.jkt;
    if (!ticket || !jkt) throw new AppError(401, 'attestation_required', 'Se requiere atestación de la app');
    const raw = await this.redis.get(attestationTicketKey(ticket));
    const device = raw ? (JSON.parse(raw) as AttestedDevice) : null;
    if (!device || device.jkt !== jkt) throw new AppError(401, 'attestation_required', 'Se requiere atestación de la app');
    if (req.auth?.deviceId && req.auth.deviceId !== device.deviceId) {
      throw new AppError(401, 'attestation_required', 'Se requiere atestación de la app');
    }
    req.device = device;
    return true;
  }
}

/** Exige MFA reciente (≤ 5 min) para operaciones sensibles. Debe ir después de AccessTokenGuard. */
@Injectable()
export class RecentMfaGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    assertRecentMfa(req.auth!);
    return true;
  }
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
  if (!auth) throw new AppError(401, 'invalid_token', 'No autenticado');
  return auth;
});
