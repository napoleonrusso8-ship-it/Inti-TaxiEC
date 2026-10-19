import { Inject, Injectable } from '@nestjs/common';
import type { BlindIndex, FieldCipher } from '@intitaxi/crypto';
import type { Pool, PoolClient } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';
import { BLIND_INDEX, FIELD_CIPHER, PG_POOL } from '../../tokens.js';

export interface UserRow {
  id: string;
  phone_enc: Buffer;
  email_enc: Buffer | null;
  email_verified_at: Date | null;
  status: 'active' | 'locked' | 'suspended' | 'deleted';
  kyc_level: number;
  sensitive_ops_locked_until: Date | null;
  created_at: Date;
}

/** AAD de cada campo cifrado: liga el texto cifrado a su tabla, columna y fila. */
export const aad = {
  userPhone: (id: string) => `identity.users.phone:${id}`,
  userEmail: (id: string) => `identity.users.email:${id}`,
  otpPhone: (id: string) => `identity.otp_challenges.phone:${id}`,
  emailVerification: (id: string) => `identity.email_verifications.email:${id}`,
};

@Injectable()
export class UsersRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
  ) {}

  phoneIndex(e164: string) {
    return this.bidx.compute('phone', e164);
  }

  emailIndex(email: string) {
    return this.bidx.compute('email', email);
  }

  async findById(id: string, c: Pool | PoolClient = this.pool): Promise<UserRow | null> {
    const { rows } = await c.query<UserRow>('SELECT * FROM identity.users WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async findByPhone(e164: string, c: Pool | PoolClient = this.pool): Promise<UserRow | null> {
    const { rows } = await c.query<UserRow>('SELECT * FROM identity.users WHERE phone_hmac = $1', [this.phoneIndex(e164)]);
    return rows[0] ?? null;
  }

  async createWithPhone(e164: string, c: PoolClient): Promise<UserRow> {
    const id = randomUUID();
    const { rows } = await c.query<UserRow>(
      `INSERT INTO identity.users (id, phone_enc, phone_hmac, phone_verified_at) VALUES ($1, $2, $3, now()) RETURNING *`,
      [id, await this.cipher.encrypt(e164, aad.userPhone(id)), this.phoneIndex(e164)],
    );
    return rows[0]!;
  }

  async phoneOf(u: UserRow): Promise<string> {
    return this.cipher.decrypt(u.phone_enc, aad.userPhone(u.id));
  }

  async emailOf(u: UserRow): Promise<string | null> {
    return u.email_enc ? this.cipher.decrypt(u.email_enc, aad.userEmail(u.id)) : null;
  }
}
