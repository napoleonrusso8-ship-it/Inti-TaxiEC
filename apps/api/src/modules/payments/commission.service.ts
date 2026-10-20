import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from '@intitaxi/db';
import { AppError, AuditService, type AppRequest } from '@intitaxi/nest-common';
import { PG_POOL } from '../../tokens.js';

export type CommissionKey = 'on_demand_bps' | 'route_fee_taxi_cents' | 'route_fee_van_cents';
export type CommissionSettings = Record<CommissionKey, number>;

/** Límites de seguridad: un error de captura en el panel no puede dejar a los conductores sin ingresos. */
const MAX: CommissionSettings = { on_demand_bps: 3000, route_fee_taxi_cents: 1000, route_fee_van_cents: 2000 };

/**
 * Comisiones de la plataforma (decisión del propietario):
 *  - viajes bajo demanda: % sobre la tarifa BASE (el recargo por demanda va íntegro al conductor);
 *  - Taxi Ruta: monto fijo por recorrido según el tipo de vehículo (los pasajeros pagan la tarifa completa al conductor).
 */
@Injectable()
export class CommissionService {
  #cache: { at: number; value: CommissionSettings } | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async settings(c: Pool | PoolClient = this.pool): Promise<CommissionSettings> {
    if (this.#cache && Date.now() - this.#cache.at < 30_000 && c === this.pool) return this.#cache.value;
    const { rows } = await c.query<{ key: CommissionKey; value: number }>('SELECT key, value FROM payments.commission_settings');
    const value = Object.fromEntries(rows.map((r) => [r.key, r.value])) as CommissionSettings;
    this.#cache = { at: Date.now(), value };
    return value;
  }

  /** Comisión de un viaje bajo demanda: solo sobre la parte base (sin recargo). */
  async onDemand(baseCents: number): Promise<number> {
    return Math.round((baseCents * (await this.settings()).on_demand_bps) / 10_000);
  }

  async routeFee(vehicleType: 'taxi' | 'van', c?: PoolClient): Promise<number> {
    const s = await this.settings(c);
    return vehicleType === 'van' ? s.route_fee_van_cents : s.route_fee_taxi_cents;
  }

  async update(adminId: string, changes: Partial<CommissionSettings>, req: AppRequest) {
    for (const [k, v] of Object.entries(changes) as [CommissionKey, number][]) {
      if (v > MAX[k]) throw new AppError(400, 'invalid_input', `${k} supera el máximo permitido (${MAX[k]})`);
      await this.pool.query('UPDATE payments.commission_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [k, v, adminId]);
    }
    this.#cache = null;
    await this.audit.record({ action: 'commission.update', resourceType: 'commission_settings', actorUserId: adminId, metadata: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v as number])) }, req);
    return this.settings();
  }
}
