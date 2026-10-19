import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ACR_MFA, type AuthContext } from '@intitaxi/auth-verifier';
import { constantTimeEqual, keyedMac, randomToken } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import {
  AccessTokenGuard,
  AppError,
  AttestationGuard,
  Auth,
  AuditService,
  OneTimeStore,
  parseInput,
  RateLimiter,
  tooManyRequests,
  type AppRequest,
  type EmailSender,
} from '@intitaxi/nest-common';
import { compactVerify, importJWK, type JWK } from 'jose';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, EMAIL_SENDER, PG_POOL } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';
import { TokenService } from '../tokens/token.service.js';

const TTL = 300;

/**
 * Step-up alternativo para quien no tiene passkey (decisión aprobada: pasajeros).
 * Combina dos factores de canales distintos al SMS: un código enviado al correo verificado
 * y una firma con la clave biométrica ligada a ESTE dispositivo. Da acr=mfa (no phr):
 * las operaciones que exigen resistencia al phishing (retiros de conductores) siguen pidiendo passkey.
 * No está disponible durante el bloqueo anti SIM swap: un atacante podría haber registrado
 * su propia clave de dispositivo en ese periodo.
 */
@Controller('v1/auth/step-up/email')
@UseGuards(AccessTokenGuard, AttestationGuard)
export class EmailStepUpController {
  readonly #pepper: Buffer;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) config: AppConfig,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(OneTimeStore) private readonly once: OneTimeStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.#pepper = Buffer.from(config.OTP_PEPPER, 'base64');
  }

  @Post('options')
  @HttpCode(200)
  async options(@Req() req: AppRequest, @Auth() auth: AuthContext) {
    const user = await this.users.findById(auth.userId);
    if (!user?.email_verified_at) throw new AppError(409, 'email_not_verified', 'Verifica tu correo para usar este método');
    if (user.sensitive_ops_locked_until && user.sensitive_ops_locked_until > new Date()) {
      throw new AppError(403, 'sensitive_ops_locked', 'Por seguridad, usa una passkey o espera a que termine el periodo de protección');
    }
    const key = await this.#deviceKey(auth.userId, req.device!.deviceId);
    if (!key) throw new AppError(409, 'no_device_key', 'Activa el inicio con Face ID / huella en este dispositivo');
    const rl = await this.limiter.hit(`stepup-email:${auth.userId}`, 5, 3600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challenge = randomToken(32);
    await this.once.put(`stepup-email:${auth.sessionId}`, { mac: keyedMac(this.#pepper, `stepup:${auth.sessionId}`, code).toString('base64'), challenge }, TTL);
    await this.email.send((await this.users.emailOf(user))!, 'Código de verificación de Inti Taxi', `Tu código para confirmar la operación es ${code}. Vence en 5 minutos. Si no lo pediste, ignora este correo.`);
    return { challenge, expiresIn: TTL };
  }

  /** Un solo intento por código (el reto se consume), limitado a 5 códigos por hora. */
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parseInput(z.object({ code: z.string().max(10), assertion: z.string().max(2048) }), body);
    const stored = await this.once.take<{ mac: string; challenge: string }>(`stepup-email:${auth.sessionId}`);
    const key = await this.#deviceKey(auth.userId, req.device!.deviceId);
    let ok = false;
    if (stored && key && /^\d{6}$/.test(input.code)) {
      const codeOk = constantTimeEqual(keyedMac(this.#pepper, `stepup:${auth.sessionId}`, input.code), Buffer.from(stored.mac, 'base64'));
      let sigOk = false;
      try {
        const { payload } = await compactVerify(input.assertion, await importJWK(key, 'ES256'));
        sigOk = (JSON.parse(new TextDecoder().decode(payload)) as { challenge?: string }).challenge === stored.challenge;
      } catch {
        sigOk = false;
      }
      ok = codeOk && sigOk;
    }
    await this.audit.record({ action: 'stepup.email_device', resourceType: 'session', resourceId: auth.sessionId, outcome: ok ? 'success' : 'denied' }, req);
    if (!ok) throw new AppError(400, 'stepup_failed', 'No se pudo verificar');
    return this.tokens.stepUp(auth.sessionId, auth.userId, ['email', 'hwk'], ACR_MFA);
  }

  async #deviceKey(userId: string, deviceId: string): Promise<JWK | null> {
    const { rows } = await this.pool.query<{ public_jwk: JWK }>(
      `SELECT public_jwk FROM identity.credentials WHERE user_id = $1 AND device_id = $2 AND type = 'device_key' AND revoked_at IS NULL`,
      [userId, deviceId],
    );
    return rows[0]?.public_jwk ?? null;
  }
}
