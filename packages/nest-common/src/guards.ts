import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenVerifier, assertRecentMfa, type AuthContext, verifyDpopProof } from '@intitaxi/auth-verifier';
import { sha256Base64Url } from '@intitaxi/crypto';
import type { Redis } from 'ioredis';
import { AppError } from './errors.js';
import { RedisDpopReplayStore } from './redis-stores.js';
import { publicUrl, type AppRequest, type AttestedDevice } from './request.js';
import { PUBLIC_BASE_URL, REDIS } from './tokens.js';

/** Exige token de acceso DPoP válido. */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(AccessTokenVerifier) private readonly verifier: AccessTokenVerifier,
    @Inject(PUBLIC_BASE_URL) private readonly baseUrl: string,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    req.auth = await this.verifier.verify({
      authorization: req.header('authorization'),
      dpop: req.header('dpop'),
      method: req.method,
      url: publicUrl(this.baseUrl, req),
    });
    return true;
  }
}

/** Exige solo una prueba DPoP (endpoints previos al login). Liga el flujo a la clave del dispositivo. */
@Injectable()
export class DpopProofGuard implements CanActivate {
  constructor(
    @Inject(RedisDpopReplayStore) private readonly replay: RedisDpopReplayStore,
    @Inject(PUBLIC_BASE_URL) private readonly baseUrl: string,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const { jkt } = await verifyDpopProof({
      proof: req.header('dpop'),
      method: req.method,
      url: publicUrl(this.baseUrl, req),
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
    const deny = () => new AppError(401, 'attestation_required', 'Se requiere atestación de la app');
    if (!ticket || !jkt) throw deny();
    const raw = await this.redis.get(attestationTicketKey(ticket));
    const device = raw ? (JSON.parse(raw) as AttestedDevice) : null;
    if (!device || device.jkt !== jkt) throw deny();
    if (req.auth?.deviceId && req.auth.deviceId !== device.deviceId) throw deny();
    req.device = { ...device, flags: device.flags ?? [] };
    return true;
  }
}

const PHR_KEY = 'intitaxi:require-phr';
/** Marca un endpoint para exigir MFA resistente al phishing (passkey), p. ej. retiros de conductores. */
export const RequirePhishingResistant = () => SetMetadata(PHR_KEY, true);

/** Exige MFA reciente (≤ 5 min) para operaciones sensibles. Debe ir después de AccessTokenGuard. */
@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const phishingResistant = this.reflector.getAllAndOverride<boolean>(PHR_KEY, [ctx.getHandler(), ctx.getClass()]) ?? false;
    assertRecentMfa(req.auth!, { phishingResistant });
    return true;
  }
}

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
  if (!auth) throw new AppError(401, 'invalid_token', 'No autenticado');
  return auth;
});

export const Device = createParamDecorator((_: unknown, ctx: ExecutionContext): AttestedDevice => {
  const device = ctx.switchToHttp().getRequest<AppRequest>().device;
  if (!device) throw new AppError(401, 'attestation_required', 'Se requiere atestación de la app');
  return device;
});
