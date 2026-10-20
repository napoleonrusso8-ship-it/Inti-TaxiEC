import { createContext, useContext } from 'react';
import type { AppSession, PartnerSession } from './session';

export const SessionContext = createContext<AppSession | null>(null);

export function useSession(): AppSession {
  const s = useContext(SessionContext);
  if (!s) throw new Error('Sesión no iniciada');
  return s;
}

/** Sesión de socio (conductor, dueño de taxi/furgoneta, empresa de alquiler o grúa). */
export function usePartner(): PartnerSession {
  return useSession().partner;
}
