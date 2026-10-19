import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { AuditService } from '../../common/audit.service.js';
import type { AppRequest } from '../../common/request.js';
import type { EmailSender } from '../../infra/notifier.js';
import { EMAIL_SENDER, PG_POOL } from '../../tokens.js';
import { UsersRepository, type UserRow } from './users.repository.js';

export const SENSITIVE_LOCK_HOURS = 72;

/**
 * Mitigación de SIM swapping. Si alguien inicia sesión SOLO con SMS en un dispositivo que la cuenta
 * nunca usó, puede ser un atacante que se hizo con el número. Entonces:
 *  - se bloquean 72 h las operaciones sensibles (retiros, cambio de cuenta bancaria, cambio de número);
 *  - se avisa por correo (canal distinto del SMS comprometido).
 * Un step-up con passkey (factor resistente al phishing y ajeno a la SIM) podrá levantar el bloqueo (módulo de pagos).
 */
@Injectable()
export class NewDeviceNotifier {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onSmsLogin(user: UserRow, deviceId: string, req: AppRequest): Promise<void> {
    const known = await this.pool.query('SELECT 1 FROM identity.sessions WHERE user_id = $1 AND device_id = $2 LIMIT 1', [user.id, deviceId]);
    if (known.rowCount) return;
    await this.pool.query(
      `UPDATE identity.users
       SET sensitive_ops_locked_until = GREATEST(COALESCE(sensitive_ops_locked_until, now()), now() + make_interval(hours => $2)), updated_at = now()
       WHERE id = $1`,
      [user.id, SENSITIVE_LOCK_HOURS],
    );
    await this.audit.record(
      { action: 'session.new_device_sms_login', resourceType: 'user', resourceId: user.id, actorUserId: user.id, actorDeviceId: deviceId, metadata: { lock_hours: SENSITIVE_LOCK_HOURS } },
      req,
    );
    const to = user.email_verified_at ? await this.users.emailOf(user) : null;
    if (to) {
      await this.email.send(
        to,
        'Nuevo inicio de sesión en Inti Taxi',
        'Se inició sesión en tu cuenta desde un dispositivo nuevo usando un código SMS. ' +
          `Por seguridad, los retiros y cambios de datos sensibles quedan bloqueados durante ${SENSITIVE_LOCK_HOURS} horas. ` +
          'Si no fuiste tú, contacta a soporte de inmediato: tu línea telefónica podría haber sido clonada.',
      );
    }
  }
}
