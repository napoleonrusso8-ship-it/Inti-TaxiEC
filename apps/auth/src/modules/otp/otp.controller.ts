import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuditService, AppError, parseInput, AttestationGuard, DpopProofGuard, type AppRequest } from '@intitaxi/nest-common';
import { withTransaction, type Pool } from '@intitaxi/db';
import { z } from 'zod';
import { ACR_BASIC } from '@intitaxi/auth-verifier';
import { PG_POOL } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';
import { NewDeviceNotifier } from '../account/new-device.notifier.js';
import { TokenService } from '../tokens/token.service.js';
import { OtpService } from './otp.service.js';

const RequestBody = z.object({ phone: z.string().min(9).max(20) });
const VerifyBody = z.object({
  challengeId: z.string().uuid(),
  code: z.string().max(10),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
});

@Controller('v1/auth/otp')
@UseGuards(DpopProofGuard, AttestationGuard)
export class OtpController {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(NewDeviceNotifier) private readonly newDevice: NewDeviceNotifier,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Post('request')
  @HttpCode(202)
  request(@Req() req: AppRequest, @Body() body: unknown) {
    const { phone } = parseInput(RequestBody, body);
    return this.otp.request({ phone, purpose: 'login', deviceId: req.device!.deviceId }, req);
  }

  /** Verifica el OTP y devuelve un código de autorización (registro o inicio de sesión). */
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parseInput(VerifyBody, body);
    const device = req.device!;
    const { phone } = await this.otp.verify({ challengeId: input.challengeId, code: input.code, deviceId: device.deviceId, purpose: 'login' }, req);

    const { user, isNewUser } = await withTransaction(this.pool, async (c) => {
      const existing = await this.users.findByPhone(phone, c);
      if (existing) return { user: existing, isNewUser: false };
      const created = await this.users.createWithPhone(phone, c);
      await this.audit.record({ action: 'user.register', resourceType: 'user', resourceId: created.id, actorUserId: created.id, actorDeviceId: device.deviceId }, req, c);
      return { user: created, isNewUser: true };
    });
    if (user.status !== 'active') throw new AppError(403, 'account_unavailable', 'La cuenta no está disponible. Contacta a soporte.');

    // Defensa contra SIM swapping: un inicio de sesión solo con SMS desde un dispositivo nuevo
    // se notifica por correo y bloquea temporalmente las operaciones sensibles.
    if (!isNewUser) await this.newDevice.onSmsLogin(user, device.deviceId, req);

    const code = await this.tokens.issueAuthCode({
      userId: user.id,
      deviceId: device.deviceId,
      jkt: device.jkt,
      codeChallenge: input.codeChallenge,
      acr: ACR_BASIC,
      amr: ['sms'],
      authTime: Math.floor(Date.now() / 1000),
    });
    return { code, isNewUser };
  }
}
