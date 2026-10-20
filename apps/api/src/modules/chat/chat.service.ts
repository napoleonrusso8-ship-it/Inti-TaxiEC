import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { AppError, AuditService, RateLimiter, REDIS, tooManyRequests, type AppRequest } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { MEDIA_RULES, processMedia, type MediaKind } from '../../infra/media.js';
import type { StoragePort } from '../../infra/storage.js';
import { PG_POOL, STORAGE } from '../../tokens.js';
import { TripsService } from '../trips/trips.service.js';

const CHAT_ACTIVE = ['accepted', 'arrived', 'in_progress'];
const RETENTION_DAYS = 30;

/**
 * Chat con archivos entre pasajero y conductor, desde que se asigna la unidad hasta el destino.
 * El texto viaja por el servicio de tiempo real; los archivos se suben a almacenamiento privado,
 * se inspeccionan aquí (tipo real, duración, sin metadatos) y solo entonces se entregan.
 */
@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  readonly #log = new Logger('Chat');
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(TripsService) private readonly trips: TripsService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.#timer = setInterval(() => void this.purgeExpired().catch((e) => this.#log.error(e.message)), 3600_000);
    this.#timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.#timer);
  }

  async #participant(userId: string, tripId: string, requireActive: boolean) {
    const t = await this.trips.load(tripId);
    const role = t ? await this.trips.participantRole(userId, t) : null;
    if (!t || !role) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (requireActive && !CHAT_ACTIVE.includes(t.status)) throw new AppError(409, 'chat_closed', 'El chat está disponible desde que se asigna la unidad hasta llegar al destino');
    return { t, role };
  }

  async createUpload(userId: string, tripId: string, input: { kind: MediaKind; contentType: string; size: number }, req: AppRequest) {
    const { role } = await this.#participant(userId, tripId, true);
    const rule = MEDIA_RULES[input.kind];
    if (!rule.contentTypes.includes(input.contentType)) throw new AppError(400, 'invalid_type', `Tipo no permitido para ${input.kind}`);
    if (input.size > rule.maxBytes) throw new AppError(413, 'too_large', `Máximo ${Math.round(rule.maxBytes / 1024 / 1024)} MB`);
    for (const [k, max, ttl] of [[`chat-media:${tripId}:${userId}`, 30, 86_400], [`chat-media-min:${userId}`, 10, 60]] as const) {
      const rl = await this.limiter.hit(k, max, ttl);
      if (!rl.allowed) throw tooManyRequests(rl.retryAfterSeconds);
    }
    const id = randomUUID();
    const key = `chat/${tripId}/${id}`;
    await this.pool.query(
      `INSERT INTO trips.chat_media (id, trip_id, sender_user_id, sender_role, kind, content_type, storage_key, size_bytes, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + make_interval(days => $9))`,
      [id, tripId, userId, role, input.kind, input.contentType, key, input.size, RETENTION_DAYS],
    );
    await this.audit.record({ action: 'chat.media_upload_url', resourceType: 'trip', resourceId: tripId, metadata: { kind: input.kind } }, req);
    return { mediaId: id, upload: await this.storage.createUpload(key, input.contentType, rule.maxBytes) };
  }

  /** Inspecciona el archivo subido y, si es válido, lo entrega al chat. */
  async complete(userId: string, tripId: string, mediaId: string, req: AppRequest) {
    const { role } = await this.#participant(userId, tripId, true);
    const m = (await this.pool.query(`SELECT * FROM trips.chat_media WHERE id = $1 AND trip_id = $2 AND sender_user_id = $3`, [mediaId, tripId, userId])).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'Recurso no encontrado');
    if (m.status !== 'pending') throw new AppError(409, 'invalid_state', 'El archivo ya fue procesado');
    const head = await this.storage.head(m.storage_key);
    if (!head) throw new AppError(409, 'not_uploaded', 'El archivo aún no se subió');
    const raw = await this.storage.read(m.storage_key, MEDIA_RULES[m.kind as MediaKind].maxBytes + 1);
    const r = processMedia(m.kind, m.content_type, raw);
    if (!r.ok) {
      await this.storage.delete(m.storage_key);
      await this.pool.query(`UPDATE trips.chat_media SET status = 'rejected', reject_reason = $2 WHERE id = $1`, [mediaId, r.reason]);
      await this.audit.record({ action: 'chat.media_rejected', resourceType: 'trip', resourceId: tripId, outcome: 'denied', metadata: { reason: r.reason } }, req);
      const msg: Record<string, string> = { too_long: 'El video puede durar hasta 20 s y la nota de voz hasta 60 s', too_large: 'Archivo demasiado grande', malware: 'Archivo bloqueado por seguridad' };
      throw new AppError(422, `media_${r.reason}`, msg[r.reason] ?? 'Archivo no válido');
    }
    // Se reescribe saneado (fotos sin EXIF/GPS) en el mismo objeto privado.
    await this.storage.put(m.storage_key, r.data);
    await this.pool.query(`UPDATE trips.chat_media SET status = 'ready', size_bytes = $2, duration_ms = $3, ready_at = now() WHERE id = $1`, [mediaId, r.data.length, r.durationMs]);
    const message = { type: 'chat', tripId, from: role === 'requester' || role === 'passenger' ? 'passenger' : 'driver', kind: m.kind, mediaId, durationMs: r.durationMs, at: new Date().toISOString() };
    await this.redis
      .multi()
      .lpush(`rt:chat:${tripId}`, JSON.stringify(message))
      .ltrim(`rt:chat:${tripId}`, 0, 199)
      .expire(`rt:chat:${tripId}`, RETENTION_DAYS * 86400)
      .publish(`rt:trip:${tripId}`, JSON.stringify(message))
      .exec();
    await this.audit.record({ action: 'chat.media_sent', resourceType: 'trip', resourceId: tripId, metadata: { kind: m.kind } }, req);
    return message;
  }

  /** Enlace de descarga de 60 s, solo para participantes del viaje. */
  async downloadUrl(userId: string, tripId: string, mediaId: string) {
    await this.#participant(userId, tripId, false);
    const m = (await this.pool.query(`SELECT storage_key, content_type, kind, duration_ms FROM trips.chat_media WHERE id = $1 AND trip_id = $2 AND status = 'ready'`, [mediaId, tripId])).rows[0];
    if (!m) throw new AppError(404, 'not_found', 'El archivo no existe o ya expiró');
    return { url: await this.storage.createDownloadUrl(m.storage_key, 60), expiresIn: 60, contentType: m.content_type, kind: m.kind, durationMs: m.duration_ms };
  }

  /** Historial (texto y archivos) para los participantes, en orden cronológico. */
  async history(userId: string, tripId: string) {
    await this.#participant(userId, tripId, false);
    const rows = await this.redis.lrange(`rt:chat:${tripId}`, 0, 199);
    return rows.map((r) => JSON.parse(r)).reverse();
  }

  /** Retención: 30 días, salvo archivos retenidos por un reporte o por un incidente del viaje. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; storage_key: string }>(
      `SELECT m.id, m.storage_key FROM trips.chat_media m JOIN trips.trips t ON t.id = m.trip_id
       WHERE m.status IN ('pending', 'ready', 'rejected') AND m.expires_at < now() AND NOT m.legal_hold AND NOT t.incident_hold LIMIT 500`,
    );
    for (const r of rows) {
      await this.storage.delete(r.storage_key).catch(() => {});
      await this.pool.query(`UPDATE trips.chat_media SET status = 'deleted' WHERE id = $1`, [r.id]);
    }
    return rows.length;
  }

  /** Retiene los archivos de un viaje como prueba (reporte o incidente). */
  async hold(tripId: string) {
    await this.pool.query(`UPDATE trips.chat_media SET legal_hold = true WHERE trip_id = $1 AND status = 'ready'`, [tripId]);
    await this.redis.persist(`rt:chat:${tripId}`);
  }
}
