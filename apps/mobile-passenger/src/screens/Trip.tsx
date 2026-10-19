import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Share, Text, View } from 'react-native';
import { money, TRIP_STATUS, type LatLng, type TripView } from '@intitaxi/mobile-core';
import { Security } from '@intitaxi/mobile-security';
import { TripMap } from '../components/Map';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, H, Loading, P, Row, Screen, useAction } from '../ui/kit';

const ACTIVE = ['matching', 'accepted', 'arrived', 'in_progress'];

export function Trip({ tripId }: { tripId: string }) {
  const { api, realtime } = useSession();
  const [trip, setTrip] = useState<TripView | null>(null);
  const [driverLoc, setDriverLoc] = useState<LatLng | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const { error, run } = useAction();

  const load = useCallback(async () => {
    const t = await api.trip(tripId);
    setTrip(t);
    if (t.driverLocation) setDriverLoc(t.driverLocation);
  }, [api, tripId]);

  useEffect(() => {
    void run(load);
    realtime.connect();
    realtime.subscribe(`trip:${tripId}`);
    const off = realtime.on((m) => {
      if (m.type === 'status') void load();
      if (m.type === 'location') setDriverLoc({ lat: m.lat, lng: m.lng });
    });
    // Respaldo si se pierde el WebSocket: consulta cada 15 s.
    const poll = setInterval(() => void load().catch(() => {}), 15_000);
    return () => {
      off();
      clearInterval(poll);
      realtime.unsubscribe(`trip:${tripId}`);
    };
  }, [tripId]);

  // El PIN solo se muestra con la pantalla protegida contra capturas.
  const showPin = trip && ['accepted', 'arrived'].includes(trip.status);
  useEffect(() => {
    if (!showPin) return;
    void Security.setSecureScreen(true);
    void api.pin(tripId).then((r) => setPin(r.pin)).catch(() => {});
    return () => void Security.setSecureScreen(false);
  }, [showPin]);

  if (!trip) return <Screen title="Tu viaje"><Loading label="Cargando…" /></Screen>;
  const active = ACTIVE.includes(trip.status);
  return (
    <Screen title="Tu viaje">
      <H>{TRIP_STATUS[trip.status] ?? trip.status}</H>
      <TripMap
        markers={[
          { id: 'o', title: 'Origen', lat: trip.origin.lat, lng: trip.origin.lng },
          { id: 'd', title: 'Destino', lat: trip.destination.lat, lng: trip.destination.lng, color: 'green' },
          ...(driverLoc ? [{ id: 'c', title: 'Tu taxi', ...driverLoc, color: 'gold' }] : []),
        ]}
      />
      {trip.driver ? (
        <Card>
          <P style={{ fontWeight: '700' }}>
            {trip.driver.firstName} {trip.driver.identityVerified ? '· identidad verificada ✓' : ''}
          </P>
          {trip.driver.vehicle ? (
            <P>
              {trip.driver.vehicle.make} {trip.driver.vehicle.model} {trip.driver.vehicle.color} · placa <Text style={{ fontWeight: '700' }}>{trip.driver.vehicle.plate}</Text>
            </P>
          ) : null}
          <P muted>Calificación: {trip.driver.rating ?? 'nuevo'} ({trip.driver.ratingsCount})</P>
          <P muted>Comprueba la placa antes de subir.</P>
        </Card>
      ) : null}
      {showPin && pin ? (
        <Card style={{ alignItems: 'center' }}>
          <P muted>Dile este PIN al conductor al subir</P>
          <Text style={{ fontSize: 44, fontWeight: '800', letterSpacing: 10, color: C.ink }}>{pin}</Text>
        </Card>
      ) : null}
      <Card>
        <P>
          {trip.partySize} persona(s) · {trip.paymentMethod === 'cash' ? 'efectivo' : trip.paymentMethod} · {money(trip.fare.finalCents ?? trip.fare.quotedCents)}
        </P>
      </Card>
      {active && trip.status !== 'matching' ? <SosButton tripId={tripId} /> : null}
      {active ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <View style={{ flex: 1 }}>
            <Button label="Compartir viaje" kind="secondary" onPress={() => run(async () => {
              const l = await api.shareLink(tripId);
              await Share.share({ message: `Sigue mi viaje en Inti Taxi: ${l.url}` });
            })} />
          </View>
          {['matching', 'accepted', 'arrived'].includes(trip.status) ? (
            <View style={{ flex: 1 }}>
              <Button label="Cancelar" kind="secondary" onPress={() => run(async () => (await api.cancel(tripId, 'Cancelado por el pasajero'), await load()))} />
            </View>
          ) : null}
        </Row>
      ) : null}
      {trip.status === 'completed' ? <AfterTrip tripId={tripId} /> : null}
      <ErrorText error={error} />
    </Screen>
  );
}

/** SOS: mantener presionado (evita toques accidentales). Llama al 911 y avisa al centro de monitoreo. */
export function SosButton({ tripId }: { tripId: string }) {
  const { api } = useSession();
  const nav = useNav();
  const { error, run } = useAction();
  const fire = () =>
    run(async () => {
      void Linking.openURL('tel:911');
      const loc = await currentLocation().catch(() => null);
      const r = await api.sos(tripId, loc ? { lat: loc.lat, lng: loc.lng } : undefined);
      nav.push('sos', { incidentId: r.incidentId, tripId });
    });
  return (
    <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="SOS, mantener presionado" onLongPress={fire} delayLongPress={1200} style={{ backgroundColor: C.danger, borderRadius: 14, paddingVertical: 18, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>SOS · mantén presionado</Text>
      </Pressable>
      <ErrorText error={error} />
    </View>
  );
}

function AfterTrip({ tripId }: { tripId: string }) {
  const { api } = useSession();
  const [stars, setStars] = useState<'1' | '2' | '3' | '4' | '5'>('5');
  const [rated, setRated] = useState(false);
  const [receipt, setReceipt] = useState<Record<string, any> | null>(null);
  const [complaint, setComplaint] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => void api.receipt(tripId).then(setReceipt).catch(() => {}), [tripId]);
  return (
    <>
      {receipt ? (
        <Card>
          <P style={{ fontWeight: '700' }}>Recibo</P>
          <P>Total: {money(receipt.amount?.totalCents)} · {receipt.payment?.method}</P>
          {receipt.route ? <P>{receipt.route.code} · tarifa {receipt.route.fareRule}: {money(receipt.route.unitFareCents)} × {receipt.route.seats}</P> : null}
          <P muted>{receipt.trip?.start} → {receipt.trip?.end} (hora de Guayaquil)</P>
        </Card>
      ) : null}
      {!rated ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Cómo estuvo tu viaje?</P>
          <Choice value={stars} onChange={setStars} options={(['1', '2', '3', '4', '5'] as const).map((v) => ({ value: v, label: '★'.repeat(Number(v)) }))} />
          <Button label="Calificar" onPress={() => run(async () => (await api.rate(tripId, Number(stars)), setRated(true)))} loading={busy} />
        </Card>
      ) : (
        <P muted>¡Gracias por calificar!</P>
      )}
      {!sent ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Algún problema? (cobro, ruta, objetos olvidados)</P>
          <Field label="Cuéntanos qué pasó" value={complaint} onChangeText={setComplaint} multiline maxLength={2000} />
          <Button label="Enviar reclamo" kind="secondary" disabled={complaint.trim().length < 10} onPress={() => run(async () => (await api.dispute(tripId, 'other', complaint.trim()), setSent(true)))} />
        </Card>
      ) : (
        <P muted>Recibimos tu reclamo. Soporte te responderá.</P>
      )}
      <ErrorText error={error} />
    </>
  );
}
