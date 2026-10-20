import { useCallback, useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { money, type PartnerProfile, type RouteCatalogItem, type RouteInstance } from '@intitaxi/mobile-core';
import { useNav } from '../../lib/nav';
import { usePartner } from '../../lib/session-context';
import { workLocation } from '../../lib/work-location';
import { Button, C, Card, Choice, Empty, ErrorText, Field, ListItem, Loading, P, Pill, Row, Screen, Section, Stat, useAction } from '../../ui/kit';

/**
 * Taxi Ruta del lado del socio (dueño de taxi amarillo o de furgoneta):
 * pedir habilitación en una ruta, iniciar un recorrido y subir/bajar pasajeros con su PIN.
 */
export function RouteWork() {
  const { api } = usePartner();
  const nav = useNav();
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [catalog, setCatalog] = useState<RouteCatalogItem[] | null>(null);
  const [inst, setInst] = useState<RouteInstance | null | undefined>(undefined);
  const [vehicleId, setVehicleId] = useState('');
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => {
    const [p, c, i] = await Promise.all([api.profile(), api.routeCatalog(), api.routeInstance()]);
    setProfile(p);
    setCatalog(c);
    setInst(i);
    const usable = p.vehicles.filter((v) => v.status === 'approved' && (v.vehicle_type === 'taxi' || v.vehicle_type === 'van'));
    setVehicleId((cur) => cur || usable[0]?.id || '');
  }, []);
  useEffect(() => {
    void run(load);
    const t = setInterval(() => void api.routeInstance().then(setInst).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, []);

  if (!profile || !catalog || inst === undefined) return <Screen title="Taxi Ruta">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  if (inst) return <InstanceView inst={inst} reload={load} />;

  const usable = profile.vehicles.filter((v) => v.status === 'approved' && (v.vehicle_type === 'taxi' || v.vehicle_type === 'van'));
  const start = (r: RouteCatalogItem) =>
    run(async () => {
      const here = await workLocation.current();
      if (!here) return setError('Permite la ubicación para iniciar el recorrido');
      await api.online(vehicleId, { lat: here.lat, lng: here.lng }).catch(() => {});
      await workLocation.start(api);
      await api.startRoute(r.id, direction, vehicleId);
      await load();
    });

  return (
    <Screen title="Taxi Ruta" subtitle="Rutas fijas · cobro por persona">
      {usable.length === 0 ? <Card><P muted>Necesitas un taxi o una furgoneta aprobados.</P></Card> : null}
      {usable.length > 1 ? <Choice value={vehicleId} onChange={setVehicleId} options={usable.map((v) => ({ value: v.id, label: `${v.vehicle_type === 'van' ? '🚐' : '🚕'} ${v.plate}` }))} /> : null}
      <Choice value={direction} onChange={setDirection} options={[{ value: 'outbound', label: 'Ida' }, { value: 'inbound', label: 'Vuelta' }]} />
      {catalog.length === 0 ? <Empty icon="🛣️" title="No hay rutas activas" /> : null}
      {catalog.map((r) => (
        <Card key={r.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: C.ink, fontSize: 17, fontWeight: '700', flex: 1 }}>
              {r.code} · {r.name}
            </Text>
            {r.enabled ? <Pill tone="ok">Habilitado</Pill> : r.request?.status === 'pending' ? <Pill>Solicitud enviada</Pill> : r.request?.status === 'rejected' ? <Pill tone="danger">Rechazada</Pill> : null}
          </Row>
          {r.serviceHours ? <P muted>Horario {r.serviceHours.start}–{r.serviceHours.lastBoarding}</P> : null}
          {r.request?.status === 'rejected' && r.request.reason ? <P style={{ color: C.danger }}>Motivo: {r.request.reason}</P> : null}
          {r.enabled ? (
            <Button label="Iniciar recorrido" onPress={() => void start(r)} loading={busy} disabled={!vehicleId} />
          ) : r.request?.status !== 'pending' ? (
            <Button
              label="Pedir habilitación"
              kind="secondary"
              disabled={!vehicleId}
              onPress={() => run(async () => (await api.requestRoute(r.id, vehicleId), await load(), Alert.alert('Solicitud enviada', 'La operadora de la ruta la revisará.')))}
            />
          ) : null}
        </Card>
      ))}
      <ErrorText error={error} />
      <Button label="Volver" kind="ghost" onPress={() => nav.back()} />
    </Screen>
  );
}

function InstanceView({ inst, reload }: { inst: RouteInstance; reload: () => Promise<void> }) {
  const { api } = usePartner();
  const nav = useNav();
  const [pins, setPins] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const reserved = inst.bookings.filter((b) => b.status === 'reserved');
  const boarded = inst.bookings.filter((b) => b.status === 'boarded');

  return (
    <Screen title="Recorrido en curso" subtitle={inst.vehicleType === 'van' ? 'Furgoneta' : 'Taxi Ruta'}>
      <Row>
        <Stat label="Ocupados" value={`${inst.seatsTaken}/${inst.seatsTotal}`} />
        <Stat label="Por subir" value={String(reserved.length)} />
      </Row>
      <Section>Por recoger</Section>
      {reserved.length === 0 ? <P muted>No hay reservas pendientes.</P> : null}
      {reserved.map((b) => (
        <Card key={b.id}>
          <ListItem icon="🧍" title={`${b.seats} asiento(s) · sube en ${b.boarding}`} subtitle={`Baja en ${b.alighting}`} />
          <Field label="PIN del pasajero" value={pins[b.id] ?? ''} onChangeText={(v) => setPins({ ...pins, [b.id]: v })} keyboardType="number-pad" maxLength={4} />
          <Button
            label="Confirmar subida"
            disabled={(pins[b.id] ?? '').length !== 4}
            loading={busy}
            onPress={() =>
              run(async () => {
                const r = await api.board(inst.instanceId, b.id, pins[b.id]!);
                Alert.alert('Pasajero a bordo', `Tarifa ${r.fare.ruleName}: ${money(r.fare.unitCents)} × ${b.seats} = ${money(r.fare.totalCents)} (hora ${r.fare.localTime})`);
                await reload();
              })
            }
          />
        </Card>
      ))}
      <Section>A bordo</Section>
      {boarded.length === 0 ? <P muted>Nadie a bordo.</P> : null}
      {boarded.map((b) => (
        <Card key={b.id}>
          <ListItem icon="🪑" title={`${b.seats} asiento(s) · baja en ${b.alighting}`} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Button label="💬 Chat" kind="secondary" onPress={() => nav.push('chat', { tripId: b.trip_id, as: 'driver' })} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Bajó" onPress={() => run(async () => (await api.alight(inst.instanceId, b.id), await reload()))} loading={busy} />
            </View>
          </View>
        </Card>
      ))}
      <Button
        label="Terminar recorrido"
        kind="secondary"
        onPress={() =>
          run(async () => {
            await api.finishRoute(inst.instanceId);
            workLocation.stop();
            await api.offline().catch(() => {});
            await reload();
          })
        }
      />
      <ErrorText error={error} />
    </Screen>
  );
}
