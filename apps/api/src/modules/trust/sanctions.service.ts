import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from '@intitaxi/db';
import { AppError } from '@intitaxi/nest-common';
import { PG_POOL } from '../../tokens.js';

export interface ActiveSanction {
  id: string;
  type: 'suspension' | 'ban';
  endsAt: Date | null;
}

/** Consulta de sanciones vigentes. No depende de otros módulos para poder usarse en viajes, rutas y conductores. */
@Injectable()
export class SanctionsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async active(userId: string, role: 'passenger' | 'driver', c: Pool | PoolClient = this.pool): Promise<ActiveSanction | null> {
    const { rows } = await c.query<{ id: string; type: 'suspension' | 'ban'; ends_at: Date | null }>(
      `SELECT id, type, ends_at FROM support.sanctions
       WHERE user_id = $1 AND subject_role = $2 AND status = 'active' AND type IN ('suspension', 'ban') AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
       ORDER BY (type = 'ban') DESC, ends_at DESC NULLS FIRST LIMIT 1`,
      [userId, role],
    );
    return rows[0] ? { id: rows[0].id, type: rows[0].type, endsAt: rows[0].ends_at } : null;
  }

  /** Lanza 403 si la cuenta está suspendida o expulsada para ese rol. */
  async assertAllowed(userId: string, role: 'passenger' | 'driver', c?: Pool | PoolClient) {
    const s = await this.active(userId, role, c);
    if (!s) return;
    const until = s.endsAt ? ` hasta el ${s.endsAt.toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'medium', timeStyle: 'short' })}` : '';
    throw new AppError(403, s.type === 'ban' ? 'account_banned' : 'account_suspended', s.type === 'ban' ? 'Tu cuenta fue dada de baja por incumplir las normas de convivencia.' : `Tu cuenta está suspendida${until} por un reporte comprobado. Puedes apelar con soporte.`);
  }
}
