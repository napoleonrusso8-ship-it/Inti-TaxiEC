import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ACR_BASIC, type AuthContext } from '@intitaxi/auth-verifier';
import { randomToken } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { calculateJwkThumbprint, compactVerify, importJWK, type JWK } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../../common/audit.service.js';
import { AppError, parseInput, tooManyRequests } from '../../common/errors.js';
import { AccessTokenGuard, AttestationGuard, Auth, DpopProofGuard } from '../../common/guards.js';
import type { AppRequest } from '../../common/request.js';
import { OneTimeStore, RateLimiter } from '../../infra/redis-stores.js';
import { PG_POOL } from '../../tokens.js';
import { TokenService } from '../tokens/token.service.js';

const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/).max(100);
const PublicEcJwk = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: b64u, y: b64u }).strict();

/**
 * Inicio de sesión rápido con Face ID / huella.
 * La app genera un par de claves en Secure Enclave / StrongBox con control de acceso biométrico
 * (la biometría NUNCA sale del teléfono: solo desbloquea la clave). El servidor guarda la clave pública
 * y verifica firmas sobre retos de un solo uso. Esta clave es distinta de la clave DPoP.
 */
@Controller('v1/auth/device-keys')
export class DeviceKeysController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  async register(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const { publicJwk } = parseInput(z.object({ publicJwk: PublicEcJwk }), body);
    await importJWK(publicJwk as JWK, 'ES256').catch(() => {
      throw new AppError(400, 'invalid_key', 'Clave pública inválida');
    });
    const credentialId = await calculateJwkThumbprint(publicJwk as JWK);
    if (credentialId === auth.jkt) throw new AppError(400, 'invalid_key', 'La clave biométrica debe ser distinta de la clave DPoP');
    const id = randomUUID();
    await withTransaction(this.pool, async (c) => {
      // Una sola clave activa por dispositivo.
      await c.query(
        `UPDATE identity.credentials SET revoked_at = now() WHERE type = 'device_key' AND device_id = $1 AND revoked_at IS NULL`,
        [req.device!.deviceId],
      );
      await c.query(
        `INSERT INTO identity.credentials (id, user_id, type, credential_id, public_jwk, device_id) VALUES ($1, $2, 'device_key', $3, $4, $5)`,
        [id, auth.userId, credentialId, JSON.stringify(publicJwk), req.device!.deviceId],
      ).catch((e: { code?: string }) => {
        throw e.code === '23505' ? new AppError(409, 'key_exists', 'Clave ya registrada') : e;
      });
      await this.audit.record({ action: 'device_key.register', resourceType: 'credential', resourceId: id }, req, c);
    });
    return { credentialId };
  }

  @Post('challenge')
  @HttpCode(200)
  @UseGuards(DpopProofGuard, AttestationGuard)
  async challenge(@Req() req: AppRequest) {
    const rl = await this.limiter.hit(`devkey-chal:${req.device!.deviceId}`, 10, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const challengeId = randomToken(16);
    const challenge = randomToken(32);
    await this.once.put(`devkey:${challengeId}`, { challenge, deviceId: req.device!.deviceId }, 120);
    return { challengeId, challenge, expiresIn: 120 };
  }

  /** `assertion` es un JWS ES256 firmado con la clave biométrica cuyo payload es {"challenge": "..."}. */
  @Post('assert')
  @HttpCode(200)
  @UseGuards(DpopProofGuard, AttestationGuard)
  async assert(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parseInput(
      z.object({
        challengeId: z.string().max(64),
        credentialId: b64u,
        assertion: z.string().max(2048),
        codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        codeChallengeMethod: z.literal('S256'),
      }),
      body,
    );
    const device = req.device!;
    const stored = await this.once.take<{ challenge: string; deviceId: string }>(`devkey:${input.challengeId}`);
    const { rows } = await this.pool.query<{ id: string; user_id: string; public_jwk: JWK; user_status: string }>(
      `SELECT c.id, c.user_id, c.public_jwk, u.status AS user_status
       FROM identity.credentials c JOIN identity.users u ON u.id = c.user_id
       WHERE c.credential_id = $1 AND c.type = 'device_key' AND c.revoked_at IS NULL AND c.device_id = $2`,
      [input.credentialId, device.deviceId],
    );
    const cred = rows[0];
    let ok = false;
    if (stored && stored.deviceId === device.deviceId && cred && cred.user_status === 'active') {
      try {
        const { payload, protectedHeader } = await compactVerify(input.assertion, await importJWK(cred.public_jwk, 'ES256'));
        const claims = JSON.parse(new TextDecoder().decode(payload)) as { challenge?: unknown };
        ok = protectedHeader.alg === 'ES256' && claims.challenge === stored.challenge;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      await this.audit.record({ action: 'device_key.authenticate', resourceType: 'credential', resourceId: cred?.id ?? null, outcome: 'denied', actorUserId: cred?.user_id ?? null }, req);
      throw new AppError(400, 'assertion_invalid', 'No se pudo verificar');
    }
    await this.pool.query('UPDATE identity.credentials SET last_used_at = now() WHERE id = $1', [cred!.id]);
    await this.audit.record({ action: 'device_key.authenticate', resourceType: 'credential', resourceId: cred!.id, actorUserId: cred!.user_id }, req);
    // acr básico: el servidor no puede comprobar por sí mismo que la clave exige biometría
    // (eso requiere Key Attestation / App Attest). Para operaciones sensibles se pide passkey.
    const code = await this.tokens.issueAuthCode({
      userId: cred!.user_id,
      deviceId: device.deviceId,
      jkt: device.jkt,
      codeChallenge: input.codeChallenge,
      acr: ACR_BASIC,
      amr: ['hwk'],
      authTime: Math.floor(Date.now() / 1000),
    });
    return { code };
  }
}
