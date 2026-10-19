import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { AppError, AuditService, InternalAuthGuard, parseInput, type EmailSender, type SmsSender } from '@intitaxi/nest-common';
import { z } from 'zod';
import { EMAIL_SENDER, SMS_SENDER } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';

/**
 * Notificaciones a USUARIOS (con cuenta) desde otros servicios. Auth custodia el teléfono y el correo:
 * la API solo dice "avisa a este usuario" y nunca recibe sus datos de contacto.
 */
@Controller('internal/v1/notify')
@UseGuards(InternalAuthGuard)
export class InternalNotifyController {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  async notify(@Body() body: unknown) {
    const input = parseInput(
      z.object({
        userId: z.string().uuid(),
        reason: z.string().max(60),
        sms: z.string().max(480).optional(),
        email: z.object({ subject: z.string().max(120), text: z.string().max(4000) }).optional(),
      }),
      body,
    );
    const u = await this.users.findById(input.userId);
    if (!u || u.status === 'deleted') throw new AppError(404, 'not_found');
    let smsSent = false;
    let emailSent = false;
    if (input.sms) {
      await this.sms.send(await this.users.phoneOf(u), input.sms);
      smsSent = true;
    }
    if (input.email && u.email_verified_at) {
      await this.email.send((await this.users.emailOf(u))!, input.email.subject, input.email.text);
      emailSent = true;
    }
    await this.audit.record({ action: 'notify.user', resourceType: 'user', resourceId: u.id, actorRole: 'service', metadata: { reason: input.reason, sms: smsSent, email: emailSent } });
    return { sms: smsSent, email: emailSent };
  }
}
