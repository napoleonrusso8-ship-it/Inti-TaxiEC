import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from '@intitaxi/db';
import { REDIS } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';
import { PG_POOL } from '../../tokens.js';
import { PresenceService, type DriverLocation } from './presence.service.js';
import { RealtimeBridge } from './realtime-bridge.service.js';

/**
 * Ruta GPS del viaje: cada ubicación del conductor durante un viaje se publica en tiempo real
 * y se guarda (como máximo un punto cada 5 s) para el manifiesto.
 */
@Injectable()
export class TripTrackingService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RealtimeBridge) private readonly bridge: RealtimeBridge,
  ) {}

  onModuleInit() {
    this.presence.onTripLocation = (tripId, loc) => this.record(tripId, loc, 'driver');
  }

  async record(tripId: string, loc: DriverLocation, source: 'driver' | 'passenger' | 'sos', flags: string[] = []) {
    await this.bridge.publish(tripId, { type: 'location', source, lat: loc.lat, lng: loc.lng, heading: loc.heading ?? null, at: new Date(loc.at).toISOString() });
    if (source === 'driver') await this.bridge.updateLocationSnapshot(tripId, loc.lat, loc.lng);
    const throttle = source === 'sos' ? 1 : 5;
    if ((await this.redis.set(`trackpoint:${tripId}:${source}`, '1', 'EX', throttle, 'NX')) !== 'OK') return;
    await this.pool.query(
      `INSERT INTO trips.trip_locations (trip_id, at, lat, lng, speed, heading, source, flags) VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8)`,
      [tripId, loc.at, loc.lat, loc.lng, loc.speed ?? null, loc.heading ?? null, source, flags],
    );
  }

  /** Seudonimización a los 30 días (salvo incidente): ~110 m y precisión de minuto. */
  async generalizeOld(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE trips.trip_locations l SET lat = round(l.lat, 3), lng = round(l.lng, 3), at = date_trunc('minute', l.at), speed = NULL, heading = NULL, generalized = true
       FROM trips.trips t WHERE t.id = l.trip_id AND NOT l.generalized AND NOT t.incident_hold AND t.ended_at < now() - interval '30 days'`,
    );
    await this.pool.query(
      `DELETE FROM trips.trip_locations l USING trips.trips t WHERE t.id = l.trip_id AND NOT t.incident_hold AND t.retention_until < now()`,
    );
    return r.rowCount ?? 0;
  }
}
