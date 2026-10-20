import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type Route = { name: string; params?: Record<string, any> };

interface Nav {
  route: Route;
  push(name: string, params?: Record<string, any>): void;
  replace(name: string, params?: Record<string, any>): void;
  back(): void;
  reset(name: string, params?: Record<string, any>): void;
  canGoBack: boolean;
}

const Ctx = createContext<Nav | null>(null);

/** Navegación mínima por pila (sin dependencias extra). */
export function NavProvider({ initial, children }: { initial: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const nav = useMemo<Nav>(
    () => ({
      route: stack[stack.length - 1]!,
      canGoBack: stack.length > 1,
      push: (name, params) => setStack((s) => [...s, { name, params }]),
      replace: (name, params) => setStack((s) => [...s.slice(0, -1), { name, params }]),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      reset: (name, params) => setStack([{ name, params }]),
    }),
    [stack],
  );
  return <Ctx.Provider value={nav}>{children}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error('useNav fuera de NavProvider');
  return n;
}
