/**
 * Tarifa de viajes bajo demanda (precio cerrado antes de confirmar).
 * ⚠️ Valores de ejemplo: los define el negocio y la ordenanza municipal de Guayaquil.
 */
export interface OnDemandTariff {
  baseCents: number;
  perKmCents: number;
  perMinuteCents: number;
  minimumCents: number;
}

export const DEFAULT_TARIFF: OnDemandTariff = { baseCents: 150, perKmCents: 40, perMinuteCents: 10, minimumCents: 200 };

/** Redondea a múltiplos de 5 centavos (sin monedas de 1 centavo en la práctica de cobro en efectivo). */
export function onDemandFareCents(distanceM: number, durationS: number, t: OnDemandTariff = DEFAULT_TARIFF): number {
  const raw = t.baseCents + (distanceM / 1000) * t.perKmCents + (durationS / 60) * t.perMinuteCents;
  return Math.max(t.minimumCents, Math.round(raw / 5) * 5);
}
