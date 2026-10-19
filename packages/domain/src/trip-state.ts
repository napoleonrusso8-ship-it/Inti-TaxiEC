/** Máquina de estados del viaje bajo demanda. Cualquier transición no listada se rechaza. */
export type TripStatus = 'matching' | 'no_drivers' | 'accepted' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';

const TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  matching: ['accepted', 'no_drivers', 'cancelled'],
  no_drivers: [],
  accepted: ['arrived', 'cancelled'],
  arrived: ['in_progress', 'cancelled'],
  // Una vez iniciado no se cancela: se completa (o se gestiona como incidente con SOS).
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

export const canTransition = (from: TripStatus, to: TripStatus) => TRANSITIONS[from].includes(to);
export const ACTIVE_STATUSES: TripStatus[] = ['matching', 'accepted', 'arrived', 'in_progress'];
