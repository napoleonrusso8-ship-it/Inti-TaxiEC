import { describe, expect, it } from 'vitest';
import { fareBreakdown, surgeMultiplier } from './surge.js';

describe('tarifa dinámica', () => {
  it('sin exceso de demanda no hay recargo', () => {
    expect(surgeMultiplier({ demand: 0, supply: 0 })).toEqual({ multiplier: 1, reason: 'normal' });
    expect(surgeMultiplier({ demand: 3, supply: 5 }).multiplier).toBe(1);
    expect(surgeMultiplier({ demand: 4, supply: 4 }).multiplier).toBe(1);
  });
  it('sube gradualmente y nunca supera el tope', () => {
    expect(surgeMultiplier({ demand: 6, supply: 4 }).multiplier).toBe(1.15);
    expect(surgeMultiplier({ demand: 10, supply: 2 })).toEqual({ multiplier: 1.5, reason: 'high_demand' });
    expect(surgeMultiplier({ demand: 50, supply: 0 })).toEqual({ multiplier: 1.5, reason: 'no_drivers_nearby' });
    expect(surgeMultiplier({ demand: 50, supply: 1 }, 1.3).multiplier).toBe(1.3);
  });
  it('el recargo va íntegro al conductor: la comisión solo se calcula sobre la base', () => {
    const b = fareBreakdown(400, 1.25, 900);
    expect(b).toEqual({ baseCents: 400, surgeCents: 100, totalCents: 500, commissionCents: 36, driverEarnsCents: 464 });
    expect(fareBreakdown(400, 1, 900).surgeCents).toBe(0);
  });
});
