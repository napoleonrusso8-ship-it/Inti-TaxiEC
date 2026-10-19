import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { money, type PaymentMethod, type RouteDetail as Route, type RouteStop } from '@intitaxi/mobile-core';
import { TripMap } from '../components/Map';
import { CompanionsEditor, personProblem, toPerson, type PersonDraft } from '../components/PeopleForm';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, H, Loading, P, Screen, useAction } from '../ui/kit';

type Vehicle = Awaited<ReturnType<ReturnType<typeof useSession>['api']['routeVehicles']>>[number];

export function RouteDetail({ routeId }: { routeId: string }) {
  const { api, risk } = useSession();
  const nav = useNav();
  const [route, setRoute] = useState<Route | null>(null);
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [from, setFrom] = useState<RouteStop | null>(null);
  const [to, setTo] = useState<RouteStop | null>(null);
  const [companions, setCompanions] = useState<PersonDraft[]>([]);
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [quote, setQuote] = useState<{ unitFareCents: number; totalCents: number; fareName: string; note: string } | null>(null);
  const { busy, error, setError, run } = useAction();
  const seats = 1 + companions.length;

  useEffect(() => void run(async () => setRoute(await api.route(routeId))), [routeId]);
  useEffect(() => (setFrom(null), setTo(null)), [direction]);
  // Vehículos que aún no pasan por tu parada, con asientos libres y ETA (se actualiza cada 10 s).
  useEffect(() => {
    if (!from) return setVehicles(null);
    const load = () => api.routeVehicles(routeId, direction, from.id).then(setVehicles).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [from?.id, direction]);
  useEffect(() => {
    setQuote(null);
    if (from && to) void api.routeQuote(routeId, { direction, boardingStopId: from.id, alightingStopId: to.id, seats }).then(setQuote).catch((e) => setError(String(e.message)));
  }, [from?.id, to?.id, seats]);

  if (!route) return <Screen title="Taxi Ruta">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  const dir = route.directions.find((d) => d.direction === direction)!;

  const book = (v: Vehicle) => {
    for (const [i, p] of companions.entries()) {
      const problem = personProblem(p);
      if (problem) return setError(`Acompañante ${i + 1}: ${problem}`);
    }
    void run(async () => {
      const b = await api.book(routeId, { instanceId: v.instanceId, direction, boardingStopId: from!.id, alightingStopId: to!.id, seats, paymentMethod: payment, companions: companions.map(toPerson) });
      nav.replace('booking', { bookingId: b.bookingId, tripId: b.tripId });
    });
  };

  const stopButton = (s: RouteStop) => {
    const role = from?.id === s.id ? 'Subo aquí' : to?.id === s.id ? 'Bajo aquí' : null;
    const onPress = () => {
      if (!from || (from && to)) return (setFrom(s), setTo(null));
      if (s.seq <= from.seq) return setFrom(s);
      setTo(s);
    };
    return (
      <Pressable key={s.id} onPress={onPress} style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.line }}>
        <P style={{ width: 22, color: C.muted }}>{s.seq + 1}</P>
        <View style={{ flex: 1 }}>
          <P style={role ? { fontWeight: '700', color: C.accent } : undefined}>{s.name}</P>
          {s.reference ? <P muted>{s.reference}</P> : null}
        </View>
        {role ? <P style={{ color: C.accent, fontWeight: '700' }}>{role}</P> : null}
      </Pressable>
    );
  };

  return (
    <Screen title={`${route.code} · ${route.name}`}>
      <Choice value={direction} onChange={setDirection} options={route.directions.map((d) => ({ value: d.direction, label: d.label.split('(')[0]!.trim() }))} />
      <TripMap path={dir.path} markers={[...(from ? [{ id: 'f', title: from.name, lat: from.lat, lng: from.lng }] : []), ...(to ? [{ id: 't', title: to.name, lat: to.lat, lng: to.lng, color: 'green' }] : [])]} />
      <Card>
        <P muted>Toca tu parada de subida y luego la de bajada.</P>
        {dir.stops.map(stopButton)}
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Tarifas por persona</P>
        {route.fares.map((f) => (
          <P key={f.name}>
            {f.name} ({f.from}–{f.to}): {money(f.amountCents)}
          </P>
        ))}
        <P muted>{route.fareNote}</P>
      </Card>
      {from && to ? (
        <>
          <Card>
            <P style={{ fontWeight: '700' }}>Asientos: {seats}</P>
            <CompanionsEditor people={companions} onChange={setCompanions} max={3} />
            <Choice<PaymentMethod> value={payment} onChange={setPayment} options={[{ value: 'cash', label: 'Efectivo' }, ...(risk.length ? [] : [{ value: 'card' as const, label: 'Tarjeta' }, { value: 'wallet' as const, label: 'Billetera' }])]} />
            {quote ? <P>Estimado: {money(quote.unitFareCents)} × {seats} = {money(quote.totalCents)} ({quote.fareName})</P> : null}
            {quote ? <P muted>{quote.note}</P> : null}
          </Card>
          <H>Vehículos en la ruta</H>
          {vehicles === null ? <Loading /> : vehicles.length === 0 ? <P>No hay vehículos en camino a tu parada ahora.</P> : null}
          {vehicles?.map((v) => (
            <Card key={v.instanceId}>
              <P style={{ fontWeight: '700' }}>
                {v.vehicle.make} {v.vehicle.model} {v.vehicle.color} · {v.vehicle.plate}
              </P>
              <P>
                {v.seatsAvailable} asiento(s) libre(s) · {v.etaSeconds !== null ? `llega en ~${Math.max(1, Math.round(v.etaSeconds / 60))} min` : 'ETA no disponible'}
              </P>
              <Button label={`Reservar ${seats} asiento(s)`} kind="brand" disabled={v.seatsAvailable < seats} loading={busy} onPress={() => book(v)} />
            </Card>
          ))}
        </>
      ) : null}
      <ErrorText error={error} />
    </Screen>
  );
}
