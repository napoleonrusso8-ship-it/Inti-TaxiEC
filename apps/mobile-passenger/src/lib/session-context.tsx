import { createContext, useContext } from 'react';
import type { AppSession } from './session';

export const SessionContext = createContext<AppSession | null>(null);

export function useSession(): AppSession {
  const s = useContext(SessionContext);
  if (!s) throw new Error('Sesión no iniciada');
  return s;
}
