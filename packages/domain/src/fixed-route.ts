import { haversineMeters, type LatLng } from './geo.js';

export const TIMEZONE = 'America/Guayaquil';

export interface FareRule {
  id: string;
  name: string;
  /** "HH:MM" o "HH:MM:SS", hora local. Ventana [inicio, fin): puede cruzar medianoche. */
  startLocal: string;
  endLocal: string;
  amountCents: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
}

/** Horario de servicio de una ruta (hora local, [inicio, fin)). Fuera de él la ruta está cerrada. `null` = 24 h. */
export interface ServiceHours {
  start: string;
  end: string;
}

const secs = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
};

/** Fecha y hora LOCALES de Guayaquil para un instante (independiente de la zona del servidor). */
export function localParts(at: Date, timeZone = TIMEZONE): { date: string; time: string; seconds: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time, seconds: secs(time) };
}

export function inWindow(t: number, start: number, end: number) {
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * Tarifa aplicable en un instante. Para Taxi Ruta el instante es el de la CONFIRMACIÓN DEL ABORDAJE
 * (decisión aprobada): quien sube a las 21:00:00 paga la tarifa nocturna.
 */
export function fareAt(rules: FareRule[], at: Date): FareRule | null {
  const { date, seconds } = localParts(at);
  const candidates = rules.filter((r) => r.validFrom <= date && (!r.validTo || r.validTo >= date) && inWindow(seconds, secs(r.startLocal), secs(r.endLocal)));
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0] ?? null;
}

/** ¿La ruta está en servicio en este instante? (Ruta 1: 06:30–23:00; desde las 23:00 se cierra.) */
export function isOpen(hours: ServiceHours | null, at: Date): boolean {
  return !hours || inWindow(localParts(at).seconds, secs(hours.start), secs(hours.end));
}

/**
 * Las franjas deben cubrir TODO el horario de servicio (24 h si no hay horario) sin huecos ni solapes
 * (a igual prioridad). Se verifica por minuto; las horas en que la ruta está cerrada no cuentan como hueco.
 */
export function validateFareCoverage(rules: FareRule[], onDate: string, hours: ServiceHours | null = null): { ok: boolean; gaps: string[]; overlaps: string[] } {
  const active = rules.filter((r) => r.validFrom <= onDate && (!r.validTo || r.validTo >= onDate));
  const gaps: number[] = [];
  const overlaps: number[] = [];
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  for (let m = 0; m < 1440; m++) {
    if (hours && !inWindow(m * 60, secs(hours.start), secs(hours.end))) continue;
    const hit = active.filter((r) => inWindow(m * 60, secs(r.startLocal), secs(r.endLocal)));
    if (!hit.length) gaps.push(m);
    else {
      const top = Math.max(...hit.map((r) => r.priority));
      if (hit.filter((r) => r.priority === top).length > 1) overlaps.push(m);
    }
  }
  // Agrupa minutos consecutivos en tramos legibles: "21:00–23:59".
  const ranges = (list: number[]) => {
    const out: string[] = [];
    let start = list[0];
    for (let i = 1; i <= list.length; i++) {
      if (list[i] !== list[i - 1]! + 1) {
        out.push(`${fmt(start!)}–${fmt(list[i - 1]!)}`);
        start = list[i];
      }
    }
    return list.length ? out : [];
  };
  return { ok: !gaps.length && !overlaps.length, gaps: ranges(gaps), overlaps: ranges(overlaps) };
}

/** Decodifica una polilínea codificada (formato de Google Maps). */
export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < encoded.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < encoded.length + 1);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** Proyecta un punto sobre una ruta: distancia recorrida hasta la proyección y separación lateral (m). */
export function projectOnPath(path: LatLng[], p: LatLng): { alongM: number; offsetM: number } {
  let best = { alongM: 0, offsetM: Infinity };
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const ky = 110_540;
    const bx = (b.lng - a.lng) * kx;
    const by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx;
    const py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const dx = px - t * bx;
    const dy = py - t * by;
    const off = Math.hypot(dx, dy);
    const segLen = Math.sqrt(len2);
    if (off < best.offsetM) best = { alongM: acc + t * segLen, offsetM: off };
    acc += segLen;
  }
  return best;
}

export interface StopOrderReport {
  ok: boolean;
  stops: { stopId: string; name: string; seq: number; alongM: number; offsetM: number }[];
  outOfOrder: string[];
  farFromPath: string[];
  suggestedOrder: string[];
}

/**
 * Comprueba que el orden de las paradas siga el recorrido real: se proyecta cada parada sobre la ruta
 * calculada por la API de mapas entre la primera y la última parada; la distancia recorrida debe crecer.
 */
export function analyzeStopOrder(path: LatLng[], stops: { stopId: string; name: string; seq: number; lat: number; lng: number }[], maxOffsetM = 300): StopOrderReport {
  const rows = [...stops].sort((a, b) => a.seq - b.seq).map((s) => ({ stopId: s.stopId, name: s.name, seq: s.seq, ...projectOnPath(path, s) }));
  const outOfOrder: string[] = [];
  for (let i = 1; i < rows.length; i++) if (rows[i]!.alongM + 50 < rows[i - 1]!.alongM) outOfOrder.push(rows[i]!.name);
  const farFromPath = rows.filter((r) => r.offsetM > maxOffsetM).map((r) => r.name);
  const suggestedOrder = [...rows].sort((a, b) => a.alongM - b.alongM).map((r) => r.name);
  return { ok: !outOfOrder.length && !farFromPath.length, stops: rows.map((r) => ({ ...r, alongM: Math.round(r.alongM), offsetM: Math.round(r.offsetM) })), outOfOrder, farFromPath, suggestedOrder };
}

/** ETA del vehículo a una parada del recorrido; null si ya la pasó. Velocidad urbana por defecto: 20 km/h. */
export function etaSeconds(path: LatLng[], vehicle: LatLng, stop: LatLng, speedMs = 20_000 / 3600): number | null {
  const v = projectOnPath(path, vehicle).alongM;
  const s = projectOnPath(path, stop).alongM;
  if (s + 30 < v) return null;
  return Math.round(Math.max(0, s - v) / speedMs);
}

/** Ruta aproximada uniendo paradas (cuando la API de mapas no entrega polilínea). */
export function pathFromStops(stops: LatLng[]): LatLng[] {
  return stops.length > 1 ? stops : [];
}


