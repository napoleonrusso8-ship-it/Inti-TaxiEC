import { Inject, Injectable } from '@nestjs/common';
import { AuditService, AppError, tooManyRequests, ProgressiveLockout, RateLimiter, type AppRequest, type SmsSender } from '@intitaxi/nest-common';
import { constantTimeEqual, keyedMac, type FieldCipher } from '@intitaxi/crypto';
import { withTransaction, type Pool } from '@intitaxi/db';
import { normalizeEcMobile } from '@intitaxi/domain';
import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { CONFIG, FIELD_CIPHER, PG_POOL, SMS_SENDER } from '../../tokens.js';
import { aad, UsersRepository } from '../account/users.repository.js';

export const OTP_TTL_SECONDS = 300;
export type OtpPurpose = 'login' | 'phone_change';

interface ChallengeRow {
  id: string;
  purpose: OtpPurpose;
  phone_hmac: Buffer;
  phone_enc: Buffer;
  user_id: string | null;
  device_id: string;
  code_mac: Buffer;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

const INVALID = () => new AppError(400, 'invalid_code', 'Código incorrecto o expirado');

@Injectable()
export class OtpService {
  readonly #pepper: Buffer;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) config: AppConfig,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(ProgressiveLockout) private readonly lockout: ProgressiveLockout,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.#pepper = Buffer.from(config.OTP_PEPPER, 'base64');
  }

  /**
   * Envía un OTP. La respuesta es idéntica exista o no una cuenta con ese número (anti-enumeración).
   * Límites: por número (3/15 min, 10/día), por dispositivo (5/h) y por IP (30/h).
   */
  async request(input: { phone: string; purpose: OtpPurpose; deviceId: string; userId?: string }, req: AppRequest) {
    const e164 = normalizeEcMobile(input.phone);
    if (!e164) throw new AppError(400, 'invalid_phone', 'Número de celular ecuatoriano inválido');
    const phoneHmac = this.users.phoneIndex(e164);
    const scope = `otp:${phoneHmac.toString('base64url')}`;

    const locked = await this.lockout.lockedFor(scope);
    if (locked > 0) throw tooManyRequests(locked);
    for (const [key, limit, window] of [
      [`${scope}:15m`, 3, 900],
      [`${scope}:1d`, 10, 86_400],
      [`otp-dev:${input.deviceId}`, 5, 3600],
      [`otp-ip:${req.ip}`, 30, 3600],
    ] as const) {
      const r = await this.limiter.hit(key, limit, window);
      if (!r.allowed) throw tooManyRequests(r.retryAfterSeconds);
    }

    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.pool.query(
      `INSERT INTO identity.otp_challenges (id, purpose, phone_hmac, phone_enc, user_id, device_id, code_mac, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
      [id, input.purpose, phoneHmac, await this.cipher.encrypt(e164, aad.otpPhone(id)), input.userId ?? null, input.deviceId, this.#mac(id, code), OTP_TTL_SECONDS],
    );
    // Formato compatible con autocompletado ligado a dominio (WebOTP / iOS): el código solo se
    // autocompleta en la app o sitio de intitaxi.ec, lo que reduce el phishing del OTP.
    await this.sms.send(e164, `Tu código de Inti Taxi es ${code}. No lo compartas con nadie, ni con el conductor.\n\n@intitaxi.ec #${code}`);
    await this.audit.record({ action: 'otp.request', resourceType: 'otp_challenge', resourceId: id, actorDeviceId: input.deviceId, actorUserId: input.userId ?? null, metadata: { purpose: input.purpose } }, req);
    return { challengeId: id, expiresIn: OTP_TTL_SECONDS };
  }

  /**
   * Verifica el OTP: máx. 5 intentos por reto (luego se invalida) y bloqueo progresivo por número.
   * Devuelve el teléfono verificado; el llamador decide qué hacer (login o cambio de número).
   */
  async verify(input: { challengeId: string; code: string; deviceId: string; purpose: OtpPurpose; userId?: string }, req: AppRequest) {
    const result = await withTransaction(this.pool, async (c) => {
      const { rows } = await c.query<ChallengeRow>('SELECT * FROM identity.otp_challenges WHERE id = $1 FOR UPDATE', [input.challengeId]);
      const ch = rows[0];
      if (
        !ch ||
        ch.device_id !== input.deviceId ||
        ch.purpose !== input.purpose ||
        (ch.user_id ?? undefined) !== input.userId ||
        ch.consumed_at ||
        ch.expires_at < new Date() ||
        ch.attempts >= ch.max_attempts
      ) {
        return { ok: false as const, scope: ch ? `otp:${ch.phone_hmac.toString('base64url')}` : null };
      }
      const scope = `otp:${ch.phone_hmac.toString('base64url')}`;
      const locked = await this.lockout.lockedFor(scope);
      if (locked > 0) return { ok: false as const, scope: null, lockedFor: locked };

      const match = /^\d{6}$/.test(input.code) && constantTimeEqual(this.#mac(ch.id, input.code), ch.code_mac);
      const attempts = ch.attempts + 1;
      const burn = match || attempts >= ch.max_attempts;
      await c.query('UPDATE identity.otp_challenges SET attempts = $2, consumed_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1', [ch.id, attempts, burn]);
      if (!match) return { ok: false as const, scope };
      return { ok: true as const, scope, phone: await this.cipher.decrypt(ch.phone_enc, aad.otpPhone(ch.id)) };
    });

    if (!result.ok) {
      if ('lockedFor' in result && result.lockedFor) throw tooManyRequests(result.lockedFor);
      if (result.scope) await this.lockout.recordFailure(result.scope);
      await this.audit.recordSafe({ action: 'otp.verify', resourceType: 'otp_challenge', resourceId: input.challengeId, outcome: 'denied', actorDeviceId: input.deviceId }, req);
      throw INVALID();
    }
    await this.lockout.reset(result.scope);
    return { phone: result.phone };
  }

  #mac(challengeId: string, code: string) {
    return keyedMac(this.#pepper, `otp:${challengeId}`, code);
  }
}
