import { useCallback, useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import { money, type BookingView } from '@intitaxi/mobile-core';
import { Security } from '@intitaxi/mobile-security';
import { DriverProfile } from '../components/DriverProfile';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, ErrorText, H, Loading, P, Screen, useAction } from '../ui/kit';

type Vehicle = Awaited<ReturnType<ReturnType<typeof useSession>['api']['routeVehicles']>>[number];
import { SosButton } from './Trip';

const LABEL: Record<BookingView['status'], string> = {
  reserved: 'Reservado: espera en tu parada',
  boarded: 'A bordo',
  completed: 'Viaje terminado',
  cancelled: 'Reserva cancelada',
  expired: 'La reserva expiró',
};

export function Booking({ bookingId, tripId }: { bookingId: string; tripId: string }) {
  const { api, realtime } = useSession();
  const [b, setB] = useState<BookingView | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Record<string, any> | null>(null);
  const [others, setOthers] = useState<Vehicle[] | null>(null);
  const nav = useNav();
  const { busy, error, run } = useAction();
  const load = useCallback(() => api.booking(bookingId).then(setB), [bookingId]);

  useEffect(() => {
    void run(load);
    realtime.connect();
    realtime.subscribe(`trip:${tripId}`);
    const off = realtime.on((m) => m.type === 'status' && void load());
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    return () => (off(), clearInterval(t), realtime.unsubscribe(`trip:${tripId}`));
  }, [bookingId]);
  useEffect(() => {
    if (b?.status !== 'reserved') return;
    void Security.setSecureScreen(true);
    void api.pin(tripId).then((r) => setPin(r.pin)).catch(() => {});
    return () => void Security.setSecureScreen(false);
  }, [b?.status]);
  useEffect(() => {
    if (b?.status === 'completed') void api.receipt(tripId).then(setReceipt).catch(() => {});
  }, [b?.status]);

  const findOthers = () =>
    run(async () => {
      const list = await api.routeVehicles(b!.route.id, b!.route.direction, b!.route.boardingStopId);
      setOthers(list.filter((v) => v.instanceId !== b!.route.instanceId && v.seatsAvailable >= b!.seats));
    });
  const switchTo = (v: Vehicle) => {
    const last = b!.switches.used + 1 >= b!.switches.max;
    Alert.alert(`¿Cambiar a ${v.vehicle.plate}?`, last ? 'Es tu último cambio permitido en esta reserva.' : `Te quedan ${b!.switches.max - b!.switches.used} cambios.`, [
      { text: 'No' },
      { text: 'Sí, cambiar', onPress: () => void run(async () => (setB(await api.switchVehicle(bookingId, v.instanceId)), setOthers(null))) },
    ]);
  };

  if (!b) return <Screen title="Mi reserva">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  return (
    <Screen title="Mi reserva">
      <H>{LABEL[b.status]}</H>
      {b.driver ? <DriverProfile driver={b.driver} title={b.vehicleType === 'van' ? '🚐 Tu furgoneta' : '🚕 Tu taxi ruta'} /> : null}
      <Card>
        <P>
          {b.boardingStop} → {b.alightingStop} · {b.seats} asiento(s)
        </P>
        <P>
          {b.vehicleLabel} · {b.vehicle.make} {b.vehicle.model} {b.vehicle.color} · placa <Text style={{ fontWeight: '700' }}>{b.vehicle.plate}</Text>
        </P>
        {b.fare.final ? (
          <P>
            Tarifa {b.fare.ruleName}: {money(b.fare.unitCents)} × {b.seats} = <Text style={{ fontWeight: '700' }}>{money(b.fare.totalCents)}</Text>
          </P>
        ) : (
          <P>Estimado: {money(b.fare.estimatedTotalCents)} (se fija cuando el conductor confirme tu subida)</P>
        )}
      </Card>
      {b.status === 'reserved' && pin ? (
        <Card style={{ alignItems: 'center' }}>
          <P muted>Dile este PIN al conductor al subir</P>
          <Text style={{ fontSize: 44, fontWeight: '800', letterSpacing: 10, color: C.ink }}>{pin}</Text>
        </Card>
      ) : null}
      {b.status === 'boarded' ? <SosButton tripId={tripId} /> : null}
      {b.status === 'reserved' && b.switches.used < b.switches.max ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Prefieres otra unidad? ({b.switches.used} de {b.switches.max} cambios)</P>
          {others === null ? <Button label="Ver otras unidades" kind="secondary" loading={busy} onPress={() => void findOthers()} /> : null}
          {others?.length === 0 ? <P muted>No hay otras unidades con asientos para ti ahora.</P> : null}
          {others?.map((v) => (
            <Button key={v.instanceId} kind="secondary" label={`${v.vehicleType === 'van' ? '🚐' : '🚕'} ${v.vehicle.plate} · ${v.seatsAvailable} libres${v.etaSeconds !== null ? ` · ~${Math.max(1, Math.round(v.etaSeconds / 60))} min` : ''}`} onPress={() => switchTo(v)} />
          ))}
        </Card>
      ) : null}
      {b.status === 'boarded' || b.status === 'reserved' ? <Button label="💬 Chat con el conductor" kind="secondary" onPress={() => nav.push('chat', { tripId })} /> : null}
      {b.status === 'completed' || b.status === 'boarded' ? <Button label="Reportar un problema con el conductor" kind="secondary" onPress={() => nav.push('report', { tripId })} /> : null}
      {b.status === 'reserved' ? <Button label="Cancelar reserva" kind="secondary" loading={busy} onPress={() => run(async () => (await api.cancelBooking(bookingId), await load()))} /> : null}
      {receipt?.route ? (
        <Card>
          <P style={{ fontWeight: '700' }}>Recibo</P>
          <P>
            {receipt.route.code} · {receipt.route.boardingStop} → {receipt.route.alightingStop}
          </P>
          <P>
            Tarifa {receipt.route.fareRule}: {money(receipt.route.unitFareCents)} × {receipt.route.seats} = {money(receipt.amount.totalCents)}
          </P>
          <P muted>Subida: {receipt.route.boardedAt} (hora de Guayaquil)</P>
        </Card>
      ) : null}
      <ErrorText error={error} />
    </Screen>
  );
}
