export interface LatLng {
  lat: number;
  lng: number;
}

/** Distancia en metros (fórmula del haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Área de servicio inicial (Gran Guayaquil, aprox. incluye Vía a Daule y Samborondón). Configurable. */
export const GUAYAQUIL_BBOX: BBox = { minLat: -2.35, maxLat: -1.9, minLng: -80.1, maxLng: -79.75 };

export const inBBox = (p: LatLng, b: BBox) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;

export const isValidLatLng = (p: LatLng) =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/**
 * Detección de ubicación imposible (GPS falso / saltos): velocidad implícita entre dos puntos.
 * 50 m/s = 180 km/h: ningún taxi urbano la alcanza.
 */
export function impossibleJump(prev: LatLng & { at: number }, next: LatLng & { at: number }, maxSpeedMs = 50, jitterM = 100): boolean {
  const d = haversineMeters(prev, next);
  // El GPS de un teléfono oscila decenas de metros: por debajo de esa tolerancia no se juzga la velocidad.
  if (d <= jitterM) return false;
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0) return true;
  return d / dt > maxSpeedMs;
}
