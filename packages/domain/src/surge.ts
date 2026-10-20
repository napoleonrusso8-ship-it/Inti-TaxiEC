/**
 * Tarifa dinámica con tope (decisión del propietario):
 *  - sube solo cuando hay más pedidos que conductores libres cerca del origen;
 *  - nunca supera el tope (1.5x por defecto) y se redondea a pasos de 0.05 para que sea legible;
 *  - el precio queda FIJO al cotizar (el pasajero no tiene sorpresas);
 *  - el 100 % del recargo va al conductor (la comisión se calcula solo sobre la tarifa base).
 */
export interface SurgeInput {
  /** Pedidos recientes sin conductor cerca del origen (últimos minutos). */
  demand: number;
  /** Conductores libres cerca del origen. */
  supply: number;
}

export interface Surge {
  multiplier: number;
  reason: 'normal' | 'high_demand' | 'no_drivers_nearby';
}

export function surgeMultiplier(i: SurgeInput, cap = 1.5): Surge {
  const demand = Math.max(0, Math.floor(i.demand));
  const supply = Math.max(0, Math.floor(i.supply));
  if (demand === 0) return { multiplier: 1, reason: 'normal' };
  // Proporción pedidos/conductores: cada unidad por encima de 1 sube un 25 %, hasta el tope.
  const ratio = demand / Math.max(supply, 0.5);
  const raw = 1 + Math.max(0, ratio - 1) * 0.25;
  const multiplier = Math.min(cap, Math.round(raw * 20) / 20);
  if (multiplier <= 1) return { multiplier: 1, reason: 'normal' };
  return { multiplier, reason: supply === 0 ? 'no_drivers_nearby' : 'high_demand' };
}

/** Desglose del precio: el recargo se redondea a 5 centavos; la comisión aplica solo a la base. */
export function fareBreakdown(baseCents: number, multiplier: number, commissionBps: number) {
  const surgeCents = Math.round((baseCents * (multiplier - 1)) / 5) * 5;
  const commissionCents = Math.round((baseCents * commissionBps) / 10_000);
  const totalCents = baseCents + surgeCents;
  return { baseCents, surgeCents, totalCents, commissionCents, driverEarnsCents: totalCents - commissionCents };
}
