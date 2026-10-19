import { describe, expect, it } from 'vitest';
import { canTransition, GUAYAQUIL_BBOX, haversineMeters, impossibleJump, inBBox, onDemandFareCents } from './index.js';

const MALL_DEL_SOL = { lat: -2.1547, lng: -79.8929 };
const MALECON = { lat: -2.1939, lng: -79.8803 };

describe('geo', () => {
  it('distancia Mall del Sol → Malecón ≈ 4.5 km', () => {
    const d = haversineMeters(MALL_DEL_SOL, MALECON);
    expect(d).toBeGreaterThan(4000);
    expect(d).toBeLessThan(5000);
  });
  it('Guayaquil está en el área de servicio; Quito no', () => {
    expect(inBBox(MALECON, GUAYAQUIL_BBOX)).toBe(true);
    expect(inBBox({ lat: -0.18, lng: -78.47 }, GUAYAQUIL_BBOX)).toBe(false);
  });
  it('detecta saltos imposibles (GPS falso)', () => {
    expect(impossibleJump({ ...MALL_DEL_SOL, at: 0 }, { ...MALECON, at: 10_000 })).toBe(true);
    expect(impossibleJump({ ...MALL_DEL_SOL, at: 0 }, { ...MALECON, at: 600_000 })).toBe(false);
  });
});

describe('tarifa bajo demanda', () => {
  it('aplica el mínimo', () => expect(onDemandFareCents(300, 60)).toBe(200));
  it('5 km en 15 min', () => expect(onDemandFareCents(5000, 900)).toBe(500));
  it('redondea a 5 centavos', () => expect(onDemandFareCents(5123, 913) % 5).toBe(0));
});

describe('máquina de estados', () => {
  it('flujo feliz', () => {
    expect(canTransition('matching', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'arrived')).toBe(true);
    expect(canTransition('arrived', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });
  it('no se cancela un viaje en curso ni se reabre uno terminado', () => {
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('accepted', 'in_progress')).toBe(false);
  });
});
