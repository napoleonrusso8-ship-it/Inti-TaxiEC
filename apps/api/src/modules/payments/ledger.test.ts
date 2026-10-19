import { describe, expect, it } from 'vitest';
import { split } from './ledger.js';

describe('split', () => {
  it('reparte sin perder centavos', () => {
    for (const fare of [200, 355, 1005, 9999]) {
      const s = split(fare, 2000);
      expect(s.commission + s.driver).toBe(fare);
    }
  });
  it('20 % de comisión', () => expect(split(500, 2000)).toEqual({ commission: 100, driver: 400 }));
});
