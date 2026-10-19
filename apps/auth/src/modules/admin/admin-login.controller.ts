import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { ACR_PHR } from '@intitaxi/auth-verifier';
import { randomToken } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import { AppError, AuditService, DpopProofGuard, OneTimeStore, parseInput, RateLimiter, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, PG_POOL } from '../../tokens.js';
import { ADMIN_CLIENT, TokenService } from '../tokens/token.service.js';

/**
 * Inicio de sesión del panel de administración: SOLO passkey (resistente al phishing).
 * No hay atestación móvil (es un navegador): la clave DPoP vive en WebCrypto (no extraíble) y el acceso
 * de red al panel está restringido por ZTNA/VPN. El código emitido solo sirve para el cliente "intitaxi-admin".
 * Los ROLES no los decide auth: la API comprueba admin.role_assignments en cada petición.
 */
@Controller('v1/auth/admin/passkey')
@UseGuards(DpopProofGuard)
export class AdminLoginController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('options')
  @HttpCode(200)
  async options(@Req() req: AppRequest) {
    const rl = await this.limiter.hit(`admin-login-ip:${req.ip}`, 20, 600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    const options = await generateAuthenticationOptions({ rpID: this.config.WEBAUTHN_RP_ID, userVerification: 'required' });
    const flowId = randomToken(16);
    await this.once.put(`webauthn:admin:${flowId}`, { challenge: options.challenge, jkt: req.dpop!.jkt }, 300);
    return { flowId, options };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parseInput(
      z.object({
        flowId: z.string().max(64),
        response: z.object({ id: z.string().max(1024), rawId: z.string().max(1024), type: z.literal('public-key') }).passthrough(),
        codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        codeChallengeMethod: z.literal('S256'),
      }),
      body,
    );
    const jkt = req.dpop!.jkt;
    const stored = await this.once.take<{ challenge: string; jkt: string }>(`webauthn:admin:${input.flowId}`);
    if (!stored || stored.jkt !== jkt) throw new AppError(400, 'invalid_challenge', 'Reto expirado');
    const response = input.response as unknown as AuthenticationResponseJSON;
    const { rows } = await this.pool.query<{ id: string; user_id: string; credential_id: string; public_key: Buffer; sign_count: string; transports: AuthenticatorTransportFuture[]; user_status: string }>(
      `SELECT c.*, u.status AS user_status FROM identity.credentials c JOIN identity.users u ON u.id = c.user_id
       WHERE c.credential_id = $1 AND c.type = 'passkey' AND c.revoked_at IS NULL`,
      [response.id],
    );
    const cred = rows[0];
    const v = cred && cred.user_status === 'active'
      ? await verifyAuthenticationResponse({
          response,
          expectedChallenge: stored.challenge,
          expectedOrigin: this.config.WEBAUTHN_ORIGINS,
          expectedRPID: this.config.WEBAUTHN_RP_ID,
          requireUserVerification: true,
          credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.sign_count), transports: cred.transports },
        }).catch(() => null)
      : null;
    if (!v?.verified) {
      await this.audit.record({ action: 'admin.login', resourceType: 'credential', resourceId: cred?.id ?? null, outcome: 'denied', actorUserId: cred?.user_id ?? null }, req);
      throw new AppError(400, 'passkey_invalid', 'No se pudo verificar la passkey');
    }
    await this.pool.query('UPDATE identity.credentials SET sign_count = $2, last_used_at = now() WHERE id = $1', [cred!.id, v.authenticationInfo.newCounter]);
    // "Dispositivo" web: se identifica por su clave DPoP; sin atestación.
    const { rows: dev } = await this.pool.query<{ id: string }>(
      `INSERT INTO identity.devices (id, user_id, platform, dpop_jkt, attestation_status, attested_at)
       VALUES ($1, $2, 'web', $3, 'not_applicable', now())
       ON CONFLICT (dpop_jkt) DO UPDATE SET last_seen_at = now() WHERE identity.devices.platform = 'web' AND identity.devices.revoked_at IS NULL
       RETURNING id`,
      [randomUUID(), cred!.user_id, jkt],
    );
    if (!dev[0]) throw new AppError(400, 'invalid_device', 'Clave de dispositivo no válida para el panel');
    await this.audit.record({ action: 'admin.login', resourceType: 'credential', resourceId: cred!.id, actorUserId: cred!.user_id, actorDeviceId: dev[0].id }, req);
    const code = await this.tokens.issueAuthCode({
      allowedClients: [ADMIN_CLIENT],
      userId: cred!.user_id,
      deviceId: dev[0].id,
      jkt,
      codeChallenge: input.codeChallenge,
      acr: ACR_PHR,
      amr: ['hwk', 'user'],
      authTime: Math.floor(Date.now() / 1000),
    });
    return { code };
  }
}
