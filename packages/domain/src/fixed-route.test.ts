import { describe, expect, it } from 'vitest';
import { analyzeStopOrder, decodePolyline, etaSeconds, fareAt, isOpen, localParts, validateFareCoverage, type FareRule } from './fixed-route.js';

const RUTA1: FareRule[] = [
  { id: 'd', name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: 300, validFrom: '2026-01-01', validTo: null, priority: 0 },
  { id: 'n', name: 'Nocturna', startLocal: '21:00', endLocal: '06:30', amountCents: 400, validFrom: '2026-01-01', validTo: null, priority: 0 },
];
/** Instante a partir de la hora LOCAL de Guayaquil (UTC−5, sin horario de verano). */
const gye = (local: string) => new Date(`${local}-05:00`);

describe('Tarifa de Taxi Ruta (hora de Guayaquil)', () => {
  it.each([
    ['2026-10-19T06:29:59', 400],
    ['2026-10-19T06:30:00', 300],
    ['2026-10-19T12:00:00', 300],
    ['2026-10-19T20:59:59', 300],
    ['2026-10-19T21:00:00', 400],
    ['2026-10-19T23:59:59', 400],
    ['2026-10-20T00:00:00', 400],
    ['2026-10-20T03:15:00', 400],
  ])('%s → %i centavos', (local, cents) => expect(fareAt(RUTA1, gye(local))?.amountCents).toBe(cents));

  it('usa la hora de Guayaquil aunque el instante venga en UTC', () => {
    // 02:00 UTC = 21:00 del día anterior en Guayaquil → nocturna
    expect(fareAt(RUTA1, new Date('2026-10-20T02:00:00Z'))?.name).toBe('Nocturna');
    expect(localParts(new Date('2026-10-20T02:00:00Z'))).toMatchObject({ date: '2026-10-19', time: '21:00:00' });
  });

  it('respeta vigencia y prioridad (p. ej. tarifa especial de feriado)', () => {
    const feriado: FareRule = { id: 'f', name: 'Feriado', startLocal: '00:00', endLocal: '23:59:59', amountCents: 500, validFrom: '2026-11-02', validTo: '2026-11-02', priority: 10 };
    expect(fareAt([...RUTA1, feriado], gye('2026-11-02T10:00:00'))?.amountCents).toBe(500);
    expect(fareAt([...RUTA1, feriado], gye('2026-11-03T10:00:00'))?.amountCents).toBe(300);
    expect(fareAt(RUTA1, gye('2025-12-31T10:00:00'))).toBeNull();
  });

  it('valida cobertura de 24 h sin huecos ni solapes', () => {
    expect(validateFareCoverage(RUTA1, '2026-10-19').ok).toBe(true);
    const gap = validateFareCoverage([RUTA1[0]!], '2026-10-19');
    expect(gap.ok).toBe(false);
    expect(gap.gaps).toEqual(['00:00–06:29', '21:00–23:59']);
    const overlap = validateFareCoverage([...RUTA1, { ...RUTA1[0]!, id: 'x' }], '2026-10-19');
    expect(overlap.overlaps.length).toBe(1);
  });

  it('horario de servicio 06:30–23:00: las horas cerradas no son huecos, pero sí lo es un hueco dentro del horario', () => {
    const hours = { start: '06:30', end: '23:00' };
    const real: FareRule[] = [RUTA1[0]!, { ...RUTA1[1]!, endLocal: '23:00' }];
    expect(validateFareCoverage(real, '2026-10-19', hours)).toEqual({ ok: true, gaps: [], overlaps: [] });
    expect(validateFareCoverage(real, '2026-10-19').ok).toBe(false);
    expect(validateFareCoverage([RUTA1[0]!], '2026-10-19', hours).gaps).toEqual(['21:00–22:59']);
  });

  it('la ruta se cierra a las 23:00 y abre a las 06:30 (hora de Guayaquil)', () => {
    const hours = { start: '06:30', end: '23:00' };
    expect(isOpen(hours, gye('2026-10-19T06:29:59'))).toBe(false);
    expect(isOpen(hours, gye('2026-10-19T06:30:00'))).toBe(true);
    expect(isOpen(hours, gye('2026-10-19T20:59:59'))).toBe(true);
    expect(isOpen(hours, gye('2026-10-19T22:59:59'))).toBe(true);
    expect(isOpen(hours, gye('2026-10-19T23:00:00'))).toBe(false);
    expect(isOpen(null, gye('2026-10-19T03:00:00'))).toBe(true);
  });
});

describe('Recorrido', () => {
  it('decodifica polilíneas de Google (vector de la documentación)', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toEqual([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
  });

  const path = [{ lat: -2.10, lng: -79.90 }, { lat: -2.20, lng: -79.90 }];
  const stops = [
    { stopId: 'a', name: 'A', seq: 0, lat: -2.11, lng: -79.9001 },
    { stopId: 'c', name: 'C', seq: 1, lat: -2.17, lng: -79.9 },
    { stopId: 'b', name: 'B', seq: 2, lat: -2.14, lng: -79.9 },
    { stopId: 'z', name: 'Z', seq: 3, lat: -2.19, lng: -79.95 },
  ];

  it('detecta paradas fuera de orden o lejos del recorrido y propone el orden correcto', () => {
    const r = analyzeStopOrder(path, stops);
    expect(r.ok).toBe(false);
    expect(r.outOfOrder).toEqual(['B']);
    expect(r.farFromPath).toEqual(['Z']);
    expect(r.suggestedOrder).toEqual(['A', 'B', 'C', 'Z']);
  });

  it('ETA: positiva antes de la parada y nula si ya pasó', () => {
    const eta = etaSeconds(path, { lat: -2.11, lng: -79.9 }, { lat: -2.14, lng: -79.9 });
    expect(eta).toBeGreaterThan(500);
    expect(etaSeconds(path, { lat: -2.15, lng: -79.9 }, { lat: -2.14, lng: -79.9 })).toBeNull();
  });
});
