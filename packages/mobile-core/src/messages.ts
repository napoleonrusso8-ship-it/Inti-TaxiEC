import { ApiError } from './client';

/** Mensajes claros para los errores más comunes (el servidor ya envía `detail` en español). */
const FRIENDLY: Record<string, string> = {
  network: 'Sin conexión con Inti Taxi. Revisa tu internet.',
  attestation_failed: 'Este dispositivo no superó la verificación de seguridad de Google Play.',
  sensitive_ops_locked: 'Por seguridad, algunas acciones están bloqueadas unas horas tras cambiar de SIM o de teléfono.',
  rate_limited: 'Demasiados intentos. Espera un momento.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return FRIENDLY[e.code] ?? e.body?.detail ?? e.message;
  if (e instanceof TypeError) return FRIENDLY.network!;
  return e instanceof Error ? e.message : String(e);
}

export const TRIP_STATUS: Record<string, string> = {
  matching: 'Buscando conductor…',
  no_drivers: 'No hay conductores disponibles',
  accepted: 'Tu conductor va en camino',
  arrived: 'Tu conductor llegó',
  in_progress: 'En viaje',
  completed: 'Viaje terminado',
  cancelled: 'Viaje cancelado',
};
