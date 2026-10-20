import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Share, Text, View } from 'react-native';
import { DRIVER_TAGS, TAG_LABEL } from '@intitaxi/domain';
import { money, TRIP_STATUS, type LatLng, type TripView } from '@intitaxi/mobile-core';
import { Security } from '@intitaxi/mobile-security';
import { DriverProfile } from '../components/DriverProfile';
import { TripMap } from '../components/Map';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, H, Loading, P, Row, Screen, SERIF, useAction } from '../ui/kit';
import { PrefsSummary } from './Home';

const ACTIVE = ['matching', 'accepted', 'arrived', 'in_progress'];

export function Trip({ tripId }: { tripId: string }) {
  const { api, realtime } = useSession();
  const nav = useNav();
  const [trip, setTrip] = useState<TripView | null>(null);
  const [driverLoc, setDriverLoc] = useState<LatLng | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [check, setCheck] = useState<{ id: string; kind: string } | null>(null);
  const { busy, error, run } = useAction();

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
      if (m.type === 'status' || m.type === 'driver') void load();
      if (m.type === 'location') setDriverLoc({ lat: m.lat, lng: m.lng });
      if (m.type === 'chat' && m.from === 'driver') setUnread((n) => n + 1);
    });
    // Respaldo si se pierde el WebSocket, y comprobaciones de seguridad (alerta de desvío).
    const poll = setInterval(() => {
      void load().catch(() => {});
      void api.pendingSafetyCheck(tripId).then(setCheck).catch(() => {});
    }, 10_000);
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

  if (!trip) return <Screen title="Tu viaje">{error ? <ErrorText error={error} /> : <Loading label="Cargando…" />}</Screen>;
  const active = ACTIVE.includes(trip.status);
  const canReassign = ['accepted', 'arrived'].includes(trip.status);
  const reassign = () =>
    Alert.alert('¿Pedir otra unidad?', `Buscaremos otro conductor. Te quedan ${trip.reassignments.max - trip.reassignments.used} cambio(s); al sexto intento la carrera se cierra.`, [
      { text: 'No', style: 'cancel' },
      { text: 'Sí, otra unidad', onPress: () => void run(async () => (await api.reassign(tripId), setPin(null), await load())).catch(() => {}) },
    ]);

  return (
    <Screen title="Tu viaje">
      <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 24 }}>{TRIP_STATUS[trip.status] ?? trip.status}</Text>
      {check ? <SafetyPrompt tripId={tripId} checkId={check.id} onDone={() => setCheck(null)} /> : null}
      <TripMap
        markers={[
          { id: 'o', title: 'Origen', lat: trip.origin.lat, lng: trip.origin.lng },
          { id: 'd', title: 'Destino', lat: trip.destination.lat, lng: trip.destination.lng, color: 'gold' },
          ...(driverLoc ? [{ id: 'c', title: 'Tu taxi', ...driverLoc, color: 'yellow' }] : []),
        ]}
      />
      {trip.driver && active ? <DriverProfile driver={trip.driver} /> : null}
      {showPin && pin ? (
        <Card style={{ alignItems: 'center' }}>
          <P muted>PIN para subir</P>
          <Text style={{ fontSize: 44, fontWeight: '800', letterSpacing: 12, color: C.brand2 }}>{pin}</Text>
        </Card>
      ) : null}
      {trip.driver && active ? (
        <Row>
          {[
            { icon: '💬', label: 'Chat', on: () => (setUnread(0), nav.push('chat', { tripId })) },
            { icon: '🎤', label: 'Nota de voz', on: () => nav.push('chat', { tripId, start: 'voice' }) },
            { icon: '📷', label: 'Foto', on: () => nav.push('chat', { tripId, start: 'photo' }) },
            { icon: '🎬', label: 'Video', on: () => nav.push('chat', { tripId, start: 'video' }) },
          ].map((b) => (
            <Pressable key={b.label} accessibilityLabel={b.label} onPress={b.on} style={{ flex: 1, backgroundColor: C.card2, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingVertical: 10, alignItems: 'center' }}>
              <Text style={{ fontSize: 18 }}>{b.icon}</Text>
              {b.label === 'Chat' && unread ? <Text style={{ color: C.brand2, fontSize: 11 }}>{unread} nuevo(s)</Text> : null}
            </Pressable>
          ))}
        </Row>
      ) : null}
      <Card>
        <P>
          {trip.partySize} persona(s) · {trip.paymentMethod === 'cash' ? 'efectivo' : trip.paymentMethod} · {money(trip.fare.finalCents ?? trip.fare.quotedCents)}
        </P>
        <PrefsSummary prefs={trip.prefs ?? {}} />
      </Card>
      {active && trip.status !== 'matching' ? <SosButton tripId={tripId} /> : null}
      {active ? (
        <Row style={{ flexWrap: 'wrap' }}>
          {canReassign ? (
            <View style={{ flex: 1 }}>
              <Button label={`Otra unidad (${trip.reassignments.used} de ${trip.reassignments.max})`} kind="secondary" onPress={reassign} loading={busy} />
            </View>
          ) : null}
          {['matching', 'accepted', 'arrived'].includes(trip.status) ? (
            <View style={{ flex: 1 }}>
              <Button label="Cancelar" kind="secondary" onPress={() => run(async () => (await api.cancel(tripId, 'Cancelado por el pasajero'), await load()))} />
            </View>
          ) : null}
        </Row>
      ) : null}
      {active ? (
        <Button
          label="Compartir viaje en vivo"
          kind="secondary"
          onPress={() =>
            run(async () => {
              const l = await api.shareLink(tripId);
              await Share.share({ message: `Sigue mi viaje en Inti Taxi: ${l.url}` });
            })
          }
        />
      ) : null}
      {trip.status === 'completed' ? <AfterTrip tripId={tripId} /> : null}
      {trip.driver && trip.status !== 'matching' ? (
        <Pressable onPress={() => nav.push('report', { tripId })}>
          <P muted style={{ textAlign: 'center', textDecorationLine: 'underline' }}>Reportar malos tratos</P>
        </Pressable>
      ) : null}
      <ErrorText error={error} />
    </Screen>
  );
}

/** "¿Estás bien?" ante un desvío o una parada larga. Sin respuesta, se activa la ayuda automáticamente. */
function SafetyPrompt({ tripId, checkId, onDone }: { tripId: string; checkId: string; onDone: () => void }) {
  const { api } = useSession();
  const answer = async (ok: boolean) => {
    await api.answerSafetyCheck(tripId, checkId, ok).catch(() => {});
    if (!ok) void Linking.openURL('tel:911');
    onDone();
  };
  return (
    <Card style={{ borderColor: C.brand, backgroundColor: '#211C10' }}>
      <H>¿Estás bien?</H>
      <P>Notamos un cambio inusual en la ruta o una parada larga. Si no respondes en unos segundos, activaremos la ayuda.</P>
      <Row>
        <View style={{ flex: 1 }}>
          <Button label="Estoy bien" onPress={() => void answer(true)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Necesito ayuda" kind="danger" onPress={() => void answer(false)} />
        </View>
      </Row>
    </Card>
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
      <Pressable accessibilityRole="button" accessibilityLabel="SOS, mantener presionado" onLongPress={fire} delayLongPress={1200} style={{ backgroundColor: C.danger, borderRadius: 16, paddingVertical: 18, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: 1 }}>SOS · mantén presionado</Text>
      </Pressable>
      <ErrorText error={error} />
    </View>
  );
}

function AfterTrip({ tripId }: { tripId: string }) {
  const { api } = useSession();
  const [stars, setStars] = useState<'1' | '2' | '3' | '4' | '5'>('5');
  const [tags, setTags] = useState<string[]>([]);
  const [rated, setRated] = useState(false);
  const [receipt, setReceipt] = useState<Record<string, any> | null>(null);
  const [complaint, setComplaint] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => void api.receipt(tripId).then(setReceipt).catch(() => {}), [tripId]);
  const pool = Number(stars) >= 4 ? DRIVER_TAGS.positive : DRIVER_TAGS.improve;
  return (
    <>
      {receipt ? (
        <Card>
          <P style={{ fontWeight: '700' }}>Recibo</P>
          <P>
            Total: {money(receipt.amount?.totalCents)} · {receipt.payment?.method}
          </P>
          {receipt.route ? (
            <P>
              {receipt.route.code} · tarifa {receipt.route.fareRule}: {money(receipt.route.unitFareCents)} × {receipt.route.seats}
            </P>
          ) : null}
          <P muted>
            {receipt.trip?.start} → {receipt.trip?.end} (hora de Guayaquil)
          </P>
        </Card>
      ) : null}
      {!rated ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Cómo estuvo tu viaje?</P>
          <Choice value={stars} onChange={(v) => (setStars(v), setTags([]))} options={(['1', '2', '3', '4', '5'] as const).map((v) => ({ value: v, label: '★'.repeat(Number(v)) }))} />
          <P muted>{Number(stars) >= 4 ? '¿Qué destacas?' : '¿Qué se puede mejorar?'}</P>
          <Choice<string> value="" onChange={(t) => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])} options={pool.map((t) => ({ value: t, label: `${TAG_LABEL[t]}${tags.includes(t) ? ' ✓' : ''}` }))} />
          <Button label="Calificar" onPress={() => run(async () => (await api.rate(tripId, Number(stars), tags), setRated(true)))} loading={busy} />
        </Card>
      ) : (
        <P muted>¡Gracias por calificar!</P>
      )}
      {!sent ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Algún problema con el cobro, la ruta u objetos olvidados?</P>
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
