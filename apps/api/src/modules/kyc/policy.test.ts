import { describe, expect, it } from 'vitest';
import { reverificationReason, type ReverificationInput } from './reverification-policy.js';

const now = new Date('2026-10-19T12:00:00-05:00');
const base: ReverificationInput = {
  now,
  lastApprovedAt: new Date(now.getTime() - 5 * 3600_000),
  lastDeviceId: 'd1',
  currentDeviceId: 'd1',
  riskFlags: [],
  randomChecksToday: 0,
  random: 0.9,
  probability: 0.2,
};

describe('reverificationReason', () => {
  it('exige la primera verificación', () => expect(reverificationReason({ ...base, lastApprovedAt: null })).toBe('never_verified'));
  it('exige al cambiar de dispositivo, aunque sea reciente', () =>
    expect(reverificationReason({ ...base, currentDeviceId: 'd2', lastApprovedAt: new Date(now.getTime() - 60_000) })).toBe('new_device'));
  it('exige ante señales de riesgo', () => expect(reverificationReason({ ...base, riskFlags: ['complaint'] })).toBe('risk_signal'));
  it('exige si la última tiene más de 7 días', () => expect(reverificationReason({ ...base, lastApprovedAt: new Date(now.getTime() - 8 * 86400_000) })).toBe('stale'));
  it('respeta la ventana de gracia de 4 h', () => expect(reverificationReason({ ...base, random: 0, lastApprovedAt: new Date(now.getTime() - 3600_000) })).toBeNull());
  it('aplica la probabilidad aleatoria', () => {
    expect(reverificationReason({ ...base, random: 0.1 })).toBe('random_check');
    expect(reverificationReason({ ...base, random: 0.3 })).toBeNull();
  });
  it('máximo una aleatoria por día', () => expect(reverificationReason({ ...base, random: 0, randomChecksToday: 1 })).toBeNull());
});
