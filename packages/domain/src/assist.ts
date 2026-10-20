/**
 * Precio sugerido para grúas y alquiler (referencia para el usuario y piso/techo de su oferta).
 * ⚠️ Valores iniciales de referencia para Guayaquil: los ajusta el negocio.
 */
export type TowCategory = 'moto' | 'auto' | 'camioneta' | 'pesado';
export type RentalCategory = 'auto' | 'suv' | 'camioneta' | 'furgoneta';

const TOW_FACTOR: Record<TowCategory, number> = { moto: 0.7, auto: 1, camioneta: 1.3, pesado: 2.5 };
const RENTAL_PER_DAY: Record<RentalCategory, number> = { auto: 3500, suv: 5500, camioneta: 6000, furgoneta: 7000 };

const round50 = (c: number) => Math.round(c / 50) * 50;

/** Grúa: base $25 + $1.50/km hasta el destino, por la categoría del vehículo; rango ±15 %. */
export function suggestTow(distanceM: number, category: TowCategory) {
  const mid = (2500 + (distanceM / 1000) * 150) * TOW_FACTOR[category];
  return { minCents: round50(mid * 0.85), maxCents: round50(mid * 1.15) };
}

/** Alquiler: precio por día según categoría; rango ±15 % (descuento del 10 % desde 7 días). */
export function suggestRental(category: RentalCategory, days: number) {
  const mid = RENTAL_PER_DAY[category] * days * (days >= 7 ? 0.9 : 1);
  return { minCents: round50(mid * 0.85), maxCents: round50(mid * 1.15) };
}

/** La oferta del usuario debe estar entre el 50 % del mínimo sugerido y el triple del máximo. */
export function offerWithinBounds(offerCents: number, s: { minCents: number; maxCents: number }) {
  return offerCents >= Math.floor(s.minCents * 0.5) && offerCents <= s.maxCents * 3;
}
