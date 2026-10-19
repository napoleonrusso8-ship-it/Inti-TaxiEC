import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@intitaxi/auth-verifier';
import { maskPhone, type FieldCipher } from '@intitaxi/crypto';
import type { Pool } from '@intitaxi/db';
import { normalizeEcMobile, normalizePersonName } from '@intitaxi/domain';
import { AccessTokenGuard, AppError, Auth, AuditService, InternalAuthGuard, parseInput, type AppRequest, type SmsSender } from '@intitaxi/nest-common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FIELD_CIPHER, PG_POOL, SMS_SENDER } from '../../tokens.js';
import { UsersRepository } from '../account/users.repository.js';

const MAX_CONTACTS = 5;
const aad = (id: string, f: string) => `identity.trusted_contacts.${f}:${id}`;

@Controller()
export class TrustedContactsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('v1/me/trusted-contacts')
  @UseGuards(AccessTokenGuard)
  async list(@Auth() auth: AuthContext) {
    const { rows } = await this.pool.query(`SELECT id, name_enc, phone_enc FROM identity.trusted_contacts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [auth.userId]);
    return Promise.all(rows.map(async (r) => ({ id: r.id, name: await this.cipher.decrypt(r.name_enc, aad(r.id, 'name')), phone: maskPhone(await this.cipher.decrypt(r.phone_enc, aad(r.id, 'phone'))) })));
  }

  /** Se avisa al contacto por SMS de que fue agregado (transparencia LOPDP). */
  @Post('v1/me/trusted-contacts')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  async add(@Req() req: AppRequest, @Auth() auth: AuthContext, @Body() body: unknown) {
    const i = parseInput(z.object({ name: z.string().max(60), phone: z.string().max(20) }), body);
    const name = normalizePersonName(i.name);
    const phone = normalizeEcMobile(i.phone);
    if (!name || !phone) throw new AppError(400, 'invalid_contact', 'Nombre o celular inválido');
    const count = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM identity.trusted_contacts WHERE user_id = $1 AND deleted_at IS NULL`, [auth.userId]);
    if (count.rows[0]!.n >= MAX_CONTACTS) throw new AppError(409, 'too_many_contacts', `Máximo ${MAX_CONTACTS} contactos`);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO identity.trusted_contacts (id, user_id, name_enc, phone_enc, phone_hmac) VALUES ($1, $2, $3, $4, $5)`,
      [id, auth.userId, await this.cipher.encrypt(name, aad(id, 'name')), await this.cipher.encrypt(phone, aad(id, 'phone')), this.users.phoneIndex(phone)],
    ).catch((e: { code?: string }) => {
      throw e.code === '23505' ? new AppError(409, 'contact_exists', 'Ese contacto ya está registrado') : e;
    });
    await this.sms.send(phone, `Inti Taxi: ${name.split(' ')[0]}, te agregaron como contacto de confianza. Si esa persona activa una emergencia te avisaremos por SMS. Responde BAJA para no recibir avisos.`);
    await this.audit.record({ action: 'trusted_contact.add', resourceType: 'trusted_contact', resourceId: id }, req);
    return { id, name, phone: maskPhone(phone) };
  }

  @Delete('v1/me/trusted-contacts/:id')
  @HttpCode(204)
  @UseGuards(AccessTokenGuard)
  async remove(@Req() req: AppRequest, @Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.pool.query(`UPDATE identity.trusted_contacts SET deleted_at = now(), name_enc = '\\x00', phone_enc = '\\x00' WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, auth.userId]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    await this.audit.record({ action: 'trusted_contact.remove', resourceType: 'trusted_contact', resourceId: id }, req);
  }

  /** Interno (servicio SOS): alerta por SMS a los contactos de confianza del usuario. */
  @Post('internal/v1/trusted-contacts/alert')
  @HttpCode(200)
  @UseGuards(InternalAuthGuard)
  async alert(@Body() body: unknown) {
    const i = parseInput(z.object({ userId: z.string().uuid(), message: z.string().max(480), incidentId: z.string().uuid() }), body);
    const { rows } = await this.pool.query(`SELECT id, phone_enc FROM identity.trusted_contacts WHERE user_id = $1 AND deleted_at IS NULL`, [i.userId]);
    for (const r of rows) await this.sms.send(await this.cipher.decrypt(r.phone_enc, aad(r.id, 'phone')), i.message);
    await this.audit.record({ action: 'trusted_contact.alert', resourceType: 'incident', resourceId: i.incidentId, actorRole: 'service', metadata: { contacts: rows.length } });
    return { alerted: rows.length };
  }
}
