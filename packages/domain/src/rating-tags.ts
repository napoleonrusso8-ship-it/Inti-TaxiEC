/**
 * Etiquetas de calificación. Las positivas se muestran públicamente (con su conteo) en el perfil;
 * las de mejora solo las ve la persona calificada (agregadas) y el equipo de calidad.
 */
export const DRIVER_TAGS = {
  positive: ['amable', 'puntual', 'auto_limpio', 'buena_conduccion', 'conversacion_agradable', 'ruta_eficiente', 'respetuoso'],
  improve: ['llego_tarde', 'conduccion_brusca', 'auto_sucio', 'ruta_larga', 'trato_irrespetuoso'],
} as const;

export const PASSENGER_TAGS = {
  positive: ['amable', 'puntual', 'respetuoso', 'cuido_el_auto'],
  improve: ['impuntual', 'trato_irrespetuoso', 'dejo_basura'],
} as const;

export const TAG_LABEL: Record<string, string> = {
  amable: 'Amable',
  puntual: 'Puntual',
  auto_limpio: 'Auto limpio',
  buena_conduccion: 'Buena conducción',
  conversacion_agradable: 'Conversación agradable',
  ruta_eficiente: 'Ruta eficiente',
  respetuoso: 'Respetuoso',
  cuido_el_auto: 'Cuidó el auto',
  llego_tarde: 'Llegó tarde',
  conduccion_brusca: 'Conducción brusca',
  auto_sucio: 'Auto sucio',
  ruta_larga: 'Ruta más larga',
  trato_irrespetuoso: 'Trato irrespetuoso',
  impuntual: 'Impuntual',
  dejo_basura: 'Dejó basura',
};

/** Etiquetas válidas para quien califica: el pasajero califica al conductor y viceversa. */
export function allowedTags(raterRole: 'requester' | 'driver'): readonly string[] {
  const set = raterRole === 'requester' ? DRIVER_TAGS : PASSENGER_TAGS;
  return [...set.positive, ...set.improve];
}

export function isPositiveTag(tag: string): boolean {
  return (DRIVER_TAGS.positive as readonly string[]).includes(tag) || (PASSENGER_TAGS.positive as readonly string[]).includes(tag);
}
