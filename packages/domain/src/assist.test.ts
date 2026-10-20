import { describe, expect, it } from 'vitest';
import { offerWithinBounds, suggestRental, suggestTow } from './assist.js';

describe('precios sugeridos de grúa y alquiler', () => {
  it('grúa: base + km, por categoría', () => {
    expect(suggestTow(10_000, 'auto')).toEqual({ minCents: 3400, maxCents: 4600 });
    expect(suggestTow(10_000, 'pesado').minCents).toBeGreaterThan(suggestTow(10_000, 'auto').maxCents);
  });
  it('alquiler: por día con descuento semanal', () => {
    expect(suggestRental('auto', 1)).toEqual({ minCents: 3000, maxCents: 4000 });
    expect(suggestRental('auto', 7).minCents).toBeLessThan(suggestRental('auto', 1).minCents * 7);
  });
  it('la oferta del usuario tiene piso y techo razonables', () => {
    const s = { minCents: 4000, maxCents: 5000 };
    expect(offerWithinBounds(2000, s)).toBe(true);
    expect(offerWithinBounds(1999, s)).toBe(false);
    expect(offerWithinBounds(15_001, s)).toBe(false);
  });
});
