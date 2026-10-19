import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { EMAIL_SENDER, internalFetch, SMS_SENDER, type EmailSender, type SmsSender } from '@intitaxi/nest-common';
import type { AppConfig } from '../../config.js';
import { CONFIG } from '../../tokens.js';

/**
 * Notificaciones salientes.
 * - A usuarios con cuenta: se delega en auth (custodia teléfono y correo).
 * - A personas sin cuenta (terceros, acompañantes): con los datos que el solicitante registró.
 * Los fallos se registran pero no rompen el flujo del viaje.
 */
@Injectable()
export class NotificationsService {
  readonly #log = new Logger('Notifications');
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async notifyUser(userId: string, reason: string, msg: { sms?: string; email?: { subject: string; text: string } }) {
    try {
      const r = await internalFetch(Buffer.from(this.config.INTERNAL_SIGNING_SECRET, 'base64'), 'api', this.config.INTERNAL_AUTH_URL, 'POST', '/internal/v1/notify', { userId, reason, ...msg });
      return r.status === 200;
    } catch (e) {
      this.#log.error(`no se pudo notificar (${reason}): ${(e as Error).message}`);
      return false;
    }
  }

  async notifyContact(to: { phone?: string | null; email?: string | null }, msg: { sms?: string; email?: { subject: string; text: string } }) {
    try {
      if (to.phone && msg.sms) await this.sms.send(to.phone, msg.sms);
      if (to.email && msg.email) await this.email.send(to.email, msg.email.subject, msg.email.text);
      return true;
    } catch (e) {
      this.#log.error(`no se pudo notificar a un contacto: ${(e as Error).message}`);
      return false;
    }
  }
}

@Global()
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
