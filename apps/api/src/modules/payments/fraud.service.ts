import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from '@intitaxi/db';
import { randomUUID } from 'node:crypto';
import { PG_POOL } from '../../tokens.js';

export type FraudSignal = 'card_shared' | 'card_velocity' | 'device_farm' | 'pair_frequency' | 'ghost_trip' | 'mock_gps' | 'pin_bruteforce';

/**
 * Motor antifraude basado en reglas (señales con puntaje). Las señales abiertas con puntaje ≥ 60 retienen
 * los retiros del conductor hasta revisión humana. Pensado para evolucionar a un modelo con más datos.
 */
@Injectable()
export class FraudService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async signal(subjectType: 'user' | 'driver' | 'trip' | 'card' | 'device', subjectId: string, signal: FraudSignal, score: number, data: Record<string, unknown> = {}, c: Pool | PoolClient = this.pool) {
    // Una señal abierta del mismo tipo por sujeto (evita duplicados en cada evento).
    const dup = await c.query(`SELECT 1 FROM payments.fraud_signals WHERE subject_type = $1 AND subject_id = $2 AND signal = $3 AND status = 'open'`, [subjectType, subjectId, signal]);
    if (dup.rowCount) return;
    await c.query('INSERT INTO payments.fraud_signals (id, subject_type, subject_id, signal, score, data) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), subjectType, subjectId, signal, score, data]);
  }

  /** Misma tarjeta física en varias cuentas. */
  async onCardSaved(userId: string, fingerprintHmac: Buffer | null) {
    if (!fingerprintHmac) return;
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(DISTINCT user_id)::int AS n FROM payments.payment_methods WHERE fingerprint_hmac = $1`, [fingerprintHmac]);
    if (rows[0]!.n >= 3) await this.signal('user', userId, 'card_shared', 60, { accounts: rows[0]!.n });
  }

  /** Granjas de cuentas: un mismo dispositivo con muchas cuentas. */
  async onDeviceUse(deviceId: string, userId: string) {
    if (!deviceId) return;
    await this.pool.query('INSERT INTO payments.device_accounts (device_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deviceId, userId]);
    const { rows } = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM payments.device_accounts WHERE device_id = $1', [deviceId]);
    if (rows[0]!.n > 3) await this.signal('device', deviceId, 'device_farm', 50, { accounts: rows[0]!.n });
  }

  /** Al terminar un viaje: viajes fantasma, colusión conductor–pasajero y GPS falso. */
  async onTripCompleted(t: { id: string; requester_user_id: string; driver_id: string; started_at: Date | null; ended_at: Date | null; distance_m: number }, gpsFlags: number) {
    const durationS = t.started_at && t.ended_at ? (t.ended_at.getTime() - t.started_at.getTime()) / 1000 : 0;
    const points = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM trips.trip_locations WHERE trip_id = $1', [t.id]);
    if (t.distance_m > 1000 && (durationS < 60 || points.rows[0]!.n < 2)) {
      await this.signal('driver', t.driver_id, 'ghost_trip', 70, { tripId: t.id, durationS, points: points.rows[0]!.n });
    }
    const pair = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trips.trips WHERE driver_id = $1 AND requester_user_id = $2 AND status = 'completed' AND ended_at > now() - interval '7 days'`,
      [t.driver_id, t.requester_user_id],
    );
    if (pair.rows[0]!.n >= 5) await this.signal('driver', t.driver_id, 'pair_frequency', 40, { passenger: t.requester_user_id, trips: pair.rows[0]!.n });
    const shared = await this.pool.query(
      `SELECT 1 FROM payments.device_accounts a JOIN payments.device_accounts b ON a.device_id = b.device_id WHERE a.user_id = $1 AND b.user_id = $2`,
      [t.driver_id, t.requester_user_id],
    );
    if (shared.rowCount) await this.signal('driver', t.driver_id, 'pair_frequency', 80, { reason: 'mismo dispositivo que el pasajero', tripId: t.id });
    if (gpsFlags >= 3) await this.signal('driver', t.driver_id, 'mock_gps', 60, { flags: gpsFlags });
  }

  async blocksPayout(driverId: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM payments.fraud_signals WHERE subject_type = 'driver' AND subject_id = $1 AND status = 'open' AND score >= 60`, [driverId]);
    return rows.length > 0;
  }
}
