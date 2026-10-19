import type { Pool } from '@intitaxi/db';
import type { AppAttestKey, AppAttestKeyStore } from './app-attest.js';

export class PgAppAttestKeyStore implements AppAttestKeyStore {
  constructor(private readonly pool: Pool) {}

  async get(keyId: string): Promise<AppAttestKey | null> {
    const { rows } = await this.pool.query<{ key_id: string; app_id: string; public_key_der: Buffer; sign_count: string }>(
      'SELECT key_id, app_id, public_key_der, sign_count FROM identity.app_attest_keys WHERE key_id = $1 AND revoked_at IS NULL',
      [keyId],
    );
    const r = rows[0];
    return r ? { keyId: r.key_id, appId: r.app_id, publicKeyDer: r.public_key_der, signCount: Number(r.sign_count) } : null;
  }

  async insert(k: AppAttestKey & { receipt: Buffer | null; environment: string }) {
    await this.pool.query(
      'INSERT INTO identity.app_attest_keys (key_id, app_id, public_key_der, sign_count, receipt, environment) VALUES ($1, $2, $3, 0, $4, $5)',
      [k.keyId, k.appId, k.publicKeyDer, k.receipt, k.environment],
    );
  }

  async advanceCounter(keyId: string, from: number, to: number) {
    const r = await this.pool.query(
      'UPDATE identity.app_attest_keys SET sign_count = $3, last_used_at = now() WHERE key_id = $1 AND sign_count = $2 AND $3 > sign_count',
      [keyId, from, to],
    );
    return (r.rowCount ?? 0) === 1;
  }
}
