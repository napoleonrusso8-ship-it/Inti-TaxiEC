import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { PASSENGER_TAGS, TAG_LABEL } from '@intitaxi/domain';
import { money, type DriverTripView } from '@intitaxi/mobile-core';
import { TripMap } from '../../components/Map';
import { useNav } from '../../lib/nav';
import { usePartner } from '../../lib/session-context';
import { workLocation } from '../../lib/work-location';
import { Badge, Button, C, Card, Choice, ErrorText, Field, Loading, P, Row, Screen, SERIF, Stars, Tag, useAction } from '../../ui/kit';

const STATUS: Record<string, string> = { accepted: 'Ve a recoger', arrived: 'En el punto de recogida', in_progress: 'En viaje', completed: 'Viaje terminado', cancelled: 'Viaje cancelado' };
const PREF_LABEL: Record<string, string> = { quiet: '🤫 Prefiere silencio', ac: '❄ A/C', luggage: '🧳 Lleva equipaje', pet: '🐾 Viaja con mascota', wheelchair: '♿ Silla de ruedas' };

/** Viaje en curso del lado del conductor: llegar, iniciar con el PIN del pasajero, terminar y calificar. */
export function DriverTrip({ tripId }: { tripId: string }) {
  const { api, realtime } = usePartner();
  const nav = useNav();
  const [t, setT] = useState<DriverTripView | null>(null);
  const [pin, setPin] = useState('');
  const [unread, setUnread] = useState(0);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api.trip(tripId).then(setT), [tripId]);

  useEffect(() => {
    void run(load);
    realtime.connect();
    realtime.subscribe(`trip:${tripId}`);
    const off = realtime.on((m) => {
      if (m.type === 'status') void load();
      if (m.type === 'chat' && m.from === 'passenger') setUnread((n) => n + 1);
    });
    const poll = setInterval(() => void load().catch(() => {}), 10_000);
    return () => (off(), clearInterval(poll), realtime.unsubscribe(`trip:${tripId}`));
  }, [tripId]);

  if (!t) return <Screen title="Viaje">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  const p = t.passenger;
  const here = workLocation.last;
  const target = t.status === 'in_progress' ? t.destination : t.origin;
  const navigate = () => void Linking.openURL(`google.navigation:q=${target.lat},${target.lng}`).catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}`));
  const prefs = Object.entries(t.prefs ?? {}).filter(([, v]) => v).map(([k]) => PREF_LABEL[k] ?? k);
  const active = ['accepted', 'arrived', 'in_progress'].includes(t.status);

  return (
    <Screen title={STATUS[t.status] ?? t.status} subtitle={`${money(t.fare.finalCents ?? t.fare.quotedCents)} · ${t.paymentMethod === 'cash' ? 'cobra en efectivo' : 'pagado en la app'}`}>
      <TripMap
        markers={[
          { id: 'o', title: 'Recoger', lat: t.origin.lat, lng: t.origin.lng },
          { id: 'd', title: 'Destino', lat: t.destination.lat, lng: t.destination.lng, color: 'gold' },
          ...(here ? [{ id: 'me', title: 'Tú', lat: here.lat, lng: here.lng, color: 'yellow' }] : []),
        ]}
      />
      {p ? (
        <Card>
          <Row>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: C.brand2, fontSize: 20, fontWeight: '700' }}>{p.firstName.slice(0, 1)}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Row style={{ gap: 6, flexWrap: 'wrap' }}>
                <Text style={{ color: C.ink, fontSize: 17, fontWeight: '600' }}>{p.firstName}</Text>
                {p.identityVerified ? <Badge>✓ Verificado</Badge> : null}
              </Row>
              <Row style={{ gap: 6 }}>
                <Stars value={p.rating} />
                <P muted>
                  {p.rating ?? 'Nuevo'} · {p.tripsCount} viaje(s)
                </P>
              </Row>
            </View>
          </Row>
          {p.tags?.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {p.tags.map((x) => (
                <Tag key={x.tag} label={x.label} count={x.count} />
              ))}
            </View>
          ) : null}
          {p.usesChosenName ? <P muted>Usa el nombre que muestra la app.</P> : null}
          {prefs.length ? <P muted>{prefs.join(' · ')}</P> : null}
          <P muted>
            {t.partySize} persona(s) registrada(s) · {t.origin.label ?? 'Origen'} → {t.destination.label ?? 'Destino'}
          </P>
        </Card>
      ) : null}
      {active ? (
        <Row>
          <View style={{ flex: 1 }}>
            <Button label="🧭 Navegar" kind="secondary" onPress={navigate} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label={`💬 Chat${unread ? ` (${unread})` : ''}`} kind="secondary" onPress={() => (setUnread(0), nav.push('chat', { tripId, as: 'driver' }))} />
          </View>
        </Row>
      ) : null}
      {t.status === 'accepted' ? <Button label="Llegué al punto de recogida" onPress={() => run(async () => (await api.arrived(tripId), await load()))} loading={busy} /> : null}
      {t.status === 'arrived' ? (
        <Card style={{ borderColor: C.brand }}>
          <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 20 }}>Pide el PIN al pasajero</Text>
          <P muted>Comprueba que es la persona correcta antes de iniciar. Sin PIN no se inicia el viaje.</P>
          <Field label="PIN de 4 dígitos" value={pin} onChangeText={setPin} keyboardType="number-pad" maxLength={4} />
          <Button label="Iniciar viaje" disabled={pin.length !== 4} loading={busy} onPress={() => run(async () => (await api.start(tripId, pin), setPin(''), await load()))} />
        </Card>
      ) : null}
      {t.status === 'in_progress' ? <Button label="Terminar viaje" onPress={() => run(async () => (await api.complete(tripId), await load()))} loading={busy} /> : null}
      {t.status === 'completed' ? <RatePassenger tripId={tripId} /> : null}
      {t.status === 'cancelled' ? <P muted>El viaje fue cancelado.</P> : null}
      {!active ? <Button label="Volver" kind="secondary" onPress={() => nav.reset('work')} /> : null}
      <Pressable onPress={() => nav.push('report', { tripId, as: 'driver' })}>
        <P muted center style={{ textDecorationLine: 'underline' }}>
          Reportar al pasajero
        </P>
      </Pressable>
      <ErrorText error={error} />
    </Screen>
  );
}

function RatePassenger({ tripId }: { tripId: string }) {
  const { api } = usePartner();
  const [stars, setStars] = useState<'1' | '2' | '3' | '4' | '5'>('5');
  const [tags, setTags] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  const pool = Number(stars) >= 4 ? PASSENGER_TAGS.positive : PASSENGER_TAGS.improve;
  if (done) return <P muted center>¡Gracias! Tu calificación ayuda a cuidar a todos los conductores.</P>;
  return (
    <Card>
      <P style={{ fontWeight: '700' }}>Califica al pasajero</P>
      <Choice value={stars} onChange={(v) => (setStars(v), setTags([]))} options={(['1', '2', '3', '4', '5'] as const).map((v) => ({ value: v, label: '★'.repeat(Number(v)) }))} />
      <Choice<string> value="" onChange={(x) => setTags(tags.includes(x) ? tags.filter((y) => y !== x) : [...tags, x])} options={pool.map((x) => ({ value: x, label: `${TAG_LABEL[x]}${tags.includes(x) ? ' ✓' : ''}` }))} />
      <Button label="Calificar" loading={busy} onPress={() => run(async () => (await api.ratePassenger(tripId, Number(stars), tags), setDone(true)))} />
      <ErrorText error={error} />
    </Card>
  );
}
