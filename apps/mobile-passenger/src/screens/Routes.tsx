import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { money } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { C, Card, Choice, ErrorText, Loading, P, Row, Screen, SERIF, useAction } from '../ui/kit';

type VehicleFilter = 'all' | 'taxi' | 'van';

/** Taxi Ruta: rutas fijas activas con la tarifa vigente por persona en taxi y en furgoneta. */
export function Routes({ vehicleType }: { vehicleType?: 'taxi' | 'van' }) {
  const { api } = useSession();
  const nav = useNav();
  const [filter, setFilter] = useState<VehicleFilter>(vehicleType ?? 'all');
  const [routes, setRoutes] = useState<Awaited<ReturnType<typeof api.routes>> | null>(null);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setRoutes(await api.routes())), []);

  const shown = routes?.filter((r) => filter === 'all' || r.currentFares[filter]) ?? [];
  return (
    <Screen title={filter === 'van' ? 'Furgonetas' : 'Taxi Ruta'}>
      <Choice<VehicleFilter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Todas' },
          { value: 'taxi', label: '🚕 Taxi' },
          { value: 'van', label: '🚐 Furgoneta' },
        ]}
      />
      <P muted>Rutas fijas compartidas. Pagas por persona; la tarifa se fija al momento de subir (hora de Guayaquil).</P>
      {!routes ? error ? <ErrorText error={error} /> : <Loading /> : null}
      {routes && shown.length === 0 ? <P>No hay rutas activas{filter === 'van' ? ' con furgonetas' : ''} en este momento.</P> : null}
      {shown.map((r) => (
        <Pressable key={r.id} onPress={() => nav.push('route', { routeId: r.id, vehicleType: filter === 'all' ? undefined : filter })}>
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 18, flex: 1 }}>
                {r.code} · {r.name}
              </Text>
              <Text style={{ color: C.brand, fontSize: 22 }}>›</Text>
            </Row>
            <Row style={{ gap: 16 }}>
              {filter !== 'van' ? <P muted>🚕 {r.currentFares.taxi ? `${money(r.currentFares.taxi.amountCents)} · ${r.currentFares.taxi.name}` : 'sin tarifa ahora'}</P> : null}
              {filter !== 'taxi' ? <P muted>🚐 {r.currentFares.van ? `${money(r.currentFares.van.amountCents)} · ${r.currentFares.van.name}` : 'sin tarifa ahora'}</P> : null}
            </Row>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
