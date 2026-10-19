import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { money } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Card, ErrorText, Loading, P, useAction } from '../ui/kit';

/** Pestaña Taxi Ruta: rutas fijas activas con su tarifa vigente por persona. */
export function Routes() {
  const { api } = useSession();
  const nav = useNav();
  const [routes, setRoutes] = useState<Awaited<ReturnType<typeof api.routes>> | null>(null);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setRoutes(await api.routes())), []);
  if (!routes) return error ? <ErrorText error={error} /> : <Loading />;
  return (
    <>
      <P muted>Rutas fijas compartidas. Pagas por persona; la tarifa se fija al momento de subir (hora de Guayaquil).</P>
      {routes.length === 0 ? <P>No hay rutas activas en este momento.</P> : null}
      {routes.map((r) => (
        <Pressable key={r.id} onPress={() => nav.push('route', { routeId: r.id })}>
          <Card>
            <P style={{ fontWeight: '700' }}>
              {r.code} · {r.name}
            </P>
            <P muted>{r.currentFare ? `Ahora: ${r.currentFare.name} ${money(r.currentFare.amountCents)} por persona` : 'Sin tarifa vigente'}</P>
          </Card>
        </Pressable>
      ))}
    </>
  );
}
