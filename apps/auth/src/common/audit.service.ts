import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BlindIndex } from '@intitaxi/crypto';
import type { Pool, PoolClient } from '@intitaxi/db';
import { BLIND_INDEX, PG_POOL } from '../tokens.js';
import type { AppRequest } from './request.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  actorUserId?: string | null;
  actorDeviceId?: string | null;
  actorRole?: string | null;
  purpose?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Escribe en audit.audit_log (solo inserción, hash encadenado en la BD).
 * Nunca se deben incluir datos personales en claro en `metadata`.
 */
@Injectable()
export class AuditService {
  readonly #log = new Logger('Audit');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BLIND_INDEX) private readonly bidx: BlindIndex,
  ) {}

  async record(entry: AuditEntry, req?: AppRequest, client?: PoolClient): Promise<void> {
    const q = client ?? this.pool;
    await q.query(
      `INSERT INTO audit.audit_log
         (actor_user_id, actor_role, actor_device_id, action, resource_type, resource_id, outcome, purpose, ip_hmac, request_id, metadata, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '\\x00', '\\x00')`,
      [
        entry.actorUserId ?? req?.auth?.userId ?? null,
        entry.actorRole ?? null,
        entry.actorDeviceId ?? req?.device?.deviceId ?? (req?.auth?.deviceId || null),
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.outcome ?? 'success',
        entry.purpose ?? null,
        req?.ip ? this.bidx.compute('ip', req.ip) : null,
        req?.requestId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  /** Para eventos de seguridad que no deben bloquear la respuesta si la auditoría falla (se alerta). */
  async recordSafe(entry: AuditEntry, req?: AppRequest): Promise<void> {
    try {
      await this.record(entry, req);
    } catch (e) {
      this.#log.error(`fallo al auditar ${entry.action}: ${(e as Error).message}`);
    }
  }
}
