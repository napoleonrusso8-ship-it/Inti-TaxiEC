import { Inject, Injectable } from '@nestjs/common';
import { impossibleJump, type LatLng } from '@intitaxi/domain';
import { REDIS } from '@intitaxi/nest-common';
import type { Redis } from 'ioredis';

export const GEO_KEY = 'drivers:available';
const LOC_TTL = 120; // sin ubicación en 2 min, el conductor deja de recibir ofertas

export interface DriverLocation extends LatLng {
  at: number;
  heading?: number;
  speed?: number;
}

/**
 * Presencia en tiempo real de conductores (Redis GEO). Postgres guarda lo durable
 * (sesiones online, viajes); aquí solo lo efímero de alta frecuencia.
 */
@Injectable()
export class PresenceService {
  /** Lo registra el módulo de viajes para guardar la ruta y publicarla en tiempo real. */
  onTripLocation?: (tripId: string, loc: DriverLocation) => Promise<void>;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async goOnline(driverId: string, info: { vehicleId: string; seats: number; sessionId: string }, loc: DriverLocation) {
    await this.redis
      .multi()
      .hset(`driver:state:${driverId}`, { vehicleId: info.vehicleId, seats: String(info.seats), sessionId: info.sessionId })
      .expire(`driver:state:${driverId}`, 12 * 3600)
      .exec();
    await this.updateLocation(driverId, loc, { available: true });
  }

  async goOffline(driverId: string) {
    await this.redis.multi().zrem(GEO_KEY, driverId).del(`driver:state:${driverId}`, `driver:loc:${driverId}`).exec();
  }

  async state(driverId: string) {
    const s = await this.redis.hgetall(`driver:state:${driverId}`);
    return s.sessionId ? { vehicleId: s.vehicleId!, seats: Number(s.seats), sessionId: s.sessionId, tripId: s.tripId || null } : null;
  }

  async lastLocation(driverId: string): Promise<DriverLocation | null> {
    const raw = await this.redis.get(`driver:loc:${driverId}`);
    return raw ? (JSON.parse(raw) as DriverLocation) : null;
  }

  /**
   * Actualiza la ubicación. Devuelve señales de GPS falso: el cliente informa `mock` (isFromMockProvider /
   * simulación) y el servidor detecta saltos imposibles respecto de la posición anterior.
   */
  async updateLocation(driverId: string, loc: DriverLocation, opts: { available: boolean; clientMock?: boolean }) {
    const prev = await this.lastLocation(driverId);
    const flags: string[] = [];
    if (opts.clientMock) flags.push('mock_location_reported');
    if (prev && impossibleJump(prev, loc)) flags.push('impossible_jump');
    if (flags.length) {
      await this.redis.multi().incr(`driver:gpsflags:${driverId}`).expire(`driver:gpsflags:${driverId}`, 86400).exec();
      // Una ubicación sospechosa no se usa para emparejar.
      await this.redis.zrem(GEO_KEY, driverId);
      return { accepted: false, flags };
    }
    const m = this.redis.multi().set(`driver:loc:${driverId}`, JSON.stringify(loc), 'EX', LOC_TTL);
    if (opts.available) m.geoadd(GEO_KEY, loc.lng, loc.lat, driverId);
    await m.exec();
    const tripId = (await this.state(driverId))?.tripId;
    if (tripId) await this.onTripLocation?.(tripId, loc);
    return { accepted: true, flags };
  }

  async setTrip(driverId: string, tripId: string | null) {
    if (tripId) {
      await this.redis.multi().hset(`driver:state:${driverId}`, 'tripId', tripId).zrem(GEO_KEY, driverId).exec();
    } else {
      await this.redis.hdel(`driver:state:${driverId}`, 'tripId');
      const loc = await this.lastLocation(driverId);
      if (loc && (await this.state(driverId))) await this.redis.geoadd(GEO_KEY, loc.lng, loc.lat, driverId);
    }
  }

  /** Conductores disponibles cerca, ordenados por distancia (las ubicaciones vencidas se descartan). */
  async nearby(p: LatLng, radiusM: number, count = 15): Promise<{ driverId: string; distanceM: number }[]> {
    const res = (await this.redis.geosearch(GEO_KEY, 'FROMLONLAT', p.lng, p.lat, 'BYRADIUS', radiusM, 'm', 'ASC', 'COUNT', count, 'WITHDIST')) as [string, string][];
    const out: { driverId: string; distanceM: number }[] = [];
    for (const [id, dist] of res) {
      if (await this.redis.exists(`driver:loc:${id}`)) out.push({ driverId: id, distanceM: Math.round(Number(dist)) });
      else await this.redis.zrem(GEO_KEY, id);
    }
    return out;
  }

  async gpsFlags(driverId: string) {
    return Number((await this.redis.get(`driver:gpsflags:${driverId}`)) ?? 0);
  }
}
