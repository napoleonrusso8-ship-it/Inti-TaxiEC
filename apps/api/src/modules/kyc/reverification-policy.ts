/**
 * Política de re-verificación biométrica del conductor antes de conectarse.
 * Objetivo: impedir cuentas prestadas o vendidas sin pedir una selfie en cada conexión.
 */
export interface ReverificationInput {
  now: Date;
  /** Última re-verificación aprobada. */
  lastApprovedAt: Date | null;
  /** Dispositivo de la última conexión verificada. */
  lastDeviceId: string | null;
  currentDeviceId: string;
  /** Señales de riesgo activas (quejas, fraude, ubicación anómala…). */
  riskFlags: string[];
  /** Re-verificaciones aleatorias exigidas hoy. */
  randomChecksToday: number;
  /** Número aleatorio uniforme en [0, 1) — inyectado para poder probar. */
  random: number;
  probability: number;
}

export type ReverificationReason = 'never_verified' | 'new_device' | 'risk_signal' | 'random_check' | 'stale';

const HOURS = 3600_000;

export function reverificationReason(i: ReverificationInput): ReverificationReason | null {
  if (!i.lastApprovedAt) return 'never_verified';
  const age = i.now.getTime() - i.lastApprovedAt.getTime();
  if (i.lastDeviceId && i.lastDeviceId !== i.currentDeviceId) return 'new_device';
  if (i.riskFlags.length > 0 && age > 1 * HOURS) return 'risk_signal';
  if (age > 7 * 24 * HOURS) return 'stale';
  // Ventana de gracia: tras una selfie aprobada no se vuelve a pedir en 4 h (salvo las razones anteriores).
  if (age < 4 * HOURS) return null;
  if (i.randomChecksToday < 1 && i.random < i.probability) return 'random_check';
  return null;
}
