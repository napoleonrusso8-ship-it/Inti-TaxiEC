import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuditService, AppError, parseInput, tooManyRequests, AccessTokenGuard, AttestationGuard, Auth, RecentMfaGuard, RateLimiter, type AppRequest, type EmailSender, type SmsSender } from '@intitaxi/nest-common';
import { maskEmail, maskPhone, randomToken, sha256, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { normalizeEmail } from '@intitaxi/domain';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { CONFIG, EMAIL_SENDER, FIELD_CIPHER, PG_POOL, SMS_SENDER } from '../../tokens.js';
import { OtpService } from '../otp/otp.service.js';
import { TokenService } from '../tokens/token.service.js';
import { SENSITIVE_LOCK_HOURS } from './new-device.notifier.js';
import { aad, UsersRepository } from './users.repository.js';

const EMAIL_TOKEN_TTL_HOURS = 24;

@Controller()
export class AccountController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Perfil de autenticación propio. Los identificadores se devuelven enmascarados. */
  @Get('v1/me')
  @UseGuards(AccessTokenGuard)
  async me(@Auth() auth: AuthContext) {
    const u = await this.users.findById(auth.userId);
    if (!u) throw new AppError(404, 'not_found');
    const email = await this.users.emailOf(u);
    return {
      id: u.id,
      phone: maskPhone(await this.users.phoneOf(u)),
      email: email ? maskEmail(email) : null,
      emailVerified: !!u.email_verified_at,
      kycLevel: u.kyc_level,
      status: u.status,
      sensitiveOpsLockedUntil: u.sensitive_ops_locked_until,
      session: { acr: auth.acr, amr: auth.amr },
    };
  }

  /** Registra (o cambia) el correo enviando un enlace de verificación. Responde 202 siempre (anti-enumeración). */
  @Post('v1/me/email')
  @HttpCode(202)
  @UseGuards(AccessTokenGuard)
  async setEmail(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const { email: raw } = parseInput(z.object({ email: z.string().max(254) }), body);
    const email = normalizeEmail(raw);
    if (!email) throw new AppError(400, 'invalid_email', 'Correo inválido');
    const rl = await this.limiter.hit(`email-set:${auth.userId}`, 5, 3600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);

    const emailHmac = this.users.emailIndex(email);
    const taken = await this.pool.query('SELECT 1 FROM identity.users WHERE email_hmac = $1 AND id <> $2', [emailHmac, auth.userId]);
    if (taken.rowCount) {
      // No se revela al solicitante que el correo ya existe; se avisa al dueño real.
      await this.email.send(email, 'Intento de uso de tu correo en Inti Taxi', 'Alguien intentó registrar este correo en otra cuenta de Inti Taxi. Si no fuiste tú, puedes ignorar este mensaje.');
      return { status: 'pending_verification' };
    }
    const id = randomUUID();
    const token = randomToken(32);
    await this.pool.query(
      `INSERT INTO identity.email_verifications (id, user_id, email_enc, email_hmac, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
      [id, auth.userId, await this.cipher.encrypt(email, aad.emailVerification(id)), emailHmac, sha256(token), EMAIL_TOKEN_TTL_HOURS],
    );
    const link = `${this.config.EMAIL_VERIFY_URL}#token=${token}`; // en el fragmento: no llega a logs de servidores intermedios
    await this.email.send(email, 'Confirma tu correo en Inti Taxi', `Confirma tu correo abriendo este enlace (válido ${EMAIL_TOKEN_TTL_HOURS} h): ${link}`);
    await this.audit.record({ action: 'user.email_verification_sent', resourceType: 'user', resourceId: auth.userId }, req);
    return { status: 'pending_verification' };
  }

  @Post('v1/auth/email/verify')
  @HttpCode(204)
  async verifyEmail(@Req() req: AppRequest, @Body() body: unknown) {
    const { token } = parseInput(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), body);
    const rl = await this.limiter.hit(`email-verify-ip:${req.ip}`, 20, 3600);
    if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string; email_enc: Buffer; email_hmac: Buffer }>(
        `UPDATE identity.email_verifications SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING id, user_id, email_enc, email_hmac`,
        [sha256(token)],
      );
      const v = rows[0];
      if (!v) throw new AppError(400, 'invalid_token', 'Enlace inválido o expirado');
      const email = await this.cipher.decrypt(v.email_enc, aad.emailVerification(v.id));
      try {
        await c.query(
          `UPDATE identity.users SET email_enc = $2, email_hmac = $3, email_verified_at = now(), updated_at = now() WHERE id = $1`,
          [v.user_id, await this.cipher.encrypt(email, aad.userEmail(v.user_id)), v.email_hmac],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError(400, 'invalid_token', 'Enlace inválido o expirado');
        throw e;
      }
      await this.audit.record({ action: 'user.email_verified', resourceType: 'user', resourceId: v.user_id, actorUserId: v.user_id }, req, c);
    });
  }

  /** Cambio de número: exige MFA reciente (passkey) y atestación. Envía OTP al número nuevo. */
  @Post('v1/auth/phone/change')
  @HttpCode(202)
  @UseGuards(AccessTokenGuard, AttestationGuard, RecentMfaGuard)
  async requestPhoneChange(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const { phone } = parseInput(z.object({ phone: z.string().min(9).max(20) }), body);
    return this.otp.request({ phone, purpose: 'phone_change', deviceId: req.device!.deviceId, userId: auth.userId }, req);
  }

  @Post('v1/auth/phone/change/confirm')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard, AttestationGuard)
  async confirmPhoneChange(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parseInput(z.object({ challengeId: z.string().uuid(), code: z.string().max(10) }), body);
    const { phone } = await this.otp.verify({ ...input, deviceId: req.device!.deviceId, purpose: 'phone_change', userId: auth.userId }, req);

    const { oldPhone, user } = await withTransaction(this.pool, async (c) => {
      const u = await this.users.findById(auth.userId, c);
      if (!u || u.status !== 'active') throw new AppError(403, 'account_unavailable');
      const old = await this.users.phoneOf(u);
      try {
        await c.query(
          `UPDATE identity.users SET phone_enc = $2, phone_hmac = $3, phone_verified_at = now(),
             sensitive_ops_locked_until = now() + make_interval(hours => $4), updated_at = now() WHERE id = $1`,
          [u.id, await this.cipher.encrypt(phone, aad.userPhone(u.id)), this.users.phoneIndex(phone), SENSITIVE_LOCK_HOURS],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AppError(409, 'phone_unavailable', 'Ese número no se puede usar');
        throw e;
      }
      await this.audit.record({ action: 'user.phone_changed', resourceType: 'user', resourceId: u.id, metadata: { lock_hours: SENSITIVE_LOCK_HOURS } }, req, c);
      return { oldPhone: old, user: u };
    });

    const revoked = await this.tokens.revokeAllSessions(auth.userId, 'phone_changed', auth.sessionId);
    const notice = `Tu número de Inti Taxi fue cambiado. Si no fuiste tú, contacta a soporte de inmediato.`;
    await this.sms.send(oldPhone, notice);
    const email = user.email_verified_at ? await this.users.emailOf(user) : null;
    if (email) await this.email.send(email, 'Cambio de número en Inti Taxi', notice);
    return { status: 'changed', otherSessionsRevoked: revoked, sensitiveOpsLockedHours: SENSITIVE_LOCK_HOURS };
  }
}
