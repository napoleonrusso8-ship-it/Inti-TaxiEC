import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { REDIS } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { PG_POOL } from '../../tokens.js';
import { TripEvents, type TripStatusEvent } from './trip-events.js';
import { TripsService } from './trips.service.js';

const MEMBERS_TTL = 12 * 3600;
const AFTER_END_TTL = 15 * 60;

/**
 * Puente hacia el gateway de tiempo real (apps/realtime) a través de Redis:
 *  - rt:trip:{id}:members  → usuarios autorizados a suscribirse al viaje (el gateway no consulta la BD);
 *  - rt:share:{hash}       → enlaces de seguimiento válidos (terceros, contactos de confianza);
 *  - PUBLISH rt:trip:{id}  → estado, ubicación del conductor y mensajes.
 */
@Injectable()
export class RealtimeBridge implements OnModuleInit {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TripEvents) private readonly events: TripEvents,
    @Inject(TripsService) private readonly trips: TripsService,
  ) {}

  onModuleInit() {
    this.events.onStatus((e) => this.#onStatus(e));
  }

  async #onStatus(e: TripStatusEvent) {
    const key = `rt:trip:${e.tripId}:members`;
    const members = [e.requesterUserId, ...(e.driverId ? [e.driverId] : [])];
    const passengers = await this.pool.query<{ user_id: string }>(
      `SELECT p.user_id FROM trips.trip_parties tp JOIN people.persons p ON p.id = tp.person_id WHERE tp.trip_id = $1 AND p.user_id IS NOT NULL`,
      [e.tripId],
    );
    members.push(...passengers.rows.map((r) => r.user_id));
    const ended = ['completed', 'cancelled', 'no_drivers'].includes(e.to);
    const ttl = ended ? AFTER_END_TTL : MEMBERS_TTL;
    const roles: Record<string, string> = Object.fromEntries(members.map((m) => [m, 'passenger']));
    if (e.driverId) roles[e.driverId] = 'driver';
    await this.redis.multi().sadd(key, ...members).expire(key, ttl).hset(`rt:trip:${e.tripId}:roles`, roles).expire(`rt:trip:${e.tripId}:roles`, ttl).exec();
    const driver = e.driverId && e.to === 'accepted' ? await this.trips.driverCardForTracking(e.driverId, e.tripId) : undefined;
    await this.#updateSnapshot(e.tripId, { status: e.to, ...(driver ? { driver } : {}) }, ttl);
    await this.publish(e.tripId, { type: 'status', status: e.to, at: new Date().toISOString() });
    if (driver) await this.publish(e.tripId, { type: 'driver', driver });
    if (ended) {
      const links = await this.pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM trips.share_links WHERE trip_id = $1', [e.tripId]);
      for (const l of links.rows) await this.redis.expire(`rt:share:${l.token_hash.toString('base64url')}`, AFTER_END_TTL);
    }
  }

  /** Último estado conocido (para quien se conecta a mitad del viaje). */
  async #updateSnapshot(tripId: string, patch: Record<string, unknown>, ttl = MEMBERS_TTL) {
    const key = `rt:trip:${tripId}:last`;
    const prev = JSON.parse((await this.redis.get(key)) ?? '{}');
    await this.redis.set(key, JSON.stringify({ ...prev, ...patch }), 'EX', ttl);
  }

  async updateLocationSnapshot(tripId: string, lat: number, lng: number) {
    await this.#updateSnapshot(tripId, { location: { lat, lng, at: new Date().toISOString() } });
  }

  async registerShareLink(tokenHash: Buffer, tripId: string, ttlSeconds: number) {
    await this.redis.set(`rt:share:${tokenHash.toString('base64url')}`, tripId, 'EX', ttlSeconds);
  }

  async publish(tripId: string, msg: Record<string, unknown>) {
    await this.redis.publish(`rt:trip:${tripId}`, JSON.stringify(msg));
  }
}
