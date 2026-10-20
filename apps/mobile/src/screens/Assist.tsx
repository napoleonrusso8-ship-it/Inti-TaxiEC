import { useCallback, useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import { money, PLACES, type AssistView, type LatLng } from '@intitaxi/mobile-core';
import { DriverProfile } from '../components/DriverProfile';
import { TripMap } from '../components/Map';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, H, Loading, P, Row, Screen, SERIF, Stepper, useAction } from '../ui/kit';

type Point = { label: string; at: LatLng };
type Range = { minCents: number; maxCents: number };
const TOW_CATEGORIES = [
  { value: 'moto', label: '🏍 Moto' },
  { value: 'auto', label: '🚗 Auto' },
  { value: 'camioneta', label: '🛻 Camioneta' },
  { value: 'pesado', label: '🚚 Pesado' },
] as const;
const PROBLEMS = [
  { value: 'no_enciende', label: 'No enciende' },
  { value: 'choque', label: 'Choque' },
  { value: 'llanta', label: 'Llanta' },
  { value: 'sin_combustible', label: 'Sin combustible' },
  { value: 'otro', label: 'Otro' },
] as const;
const RENTAL_CATEGORIES = [
  { value: 'auto', label: 'Auto' },
  { value: 'suv', label: 'SUV' },
  { value: 'camioneta', label: 'Camioneta' },
  { value: 'furgoneta', label: 'Furgoneta' },
] as const;

/** Límites que el servidor acepta para una oferta: entre la mitad del mínimo sugerido y 3 veces el máximo. */
const bounds = (r: Range) => ({ min: Math.max(100, Math.ceil(r.minCents / 2 / 100) * 100), max: r.maxCents * 3 });
const roundUp = (c: number) => Math.ceil(c / 100) * 100;

function OfferCard({ range, offer, setOffer, note }: { range: Range | null; offer: number; setOffer: (v: number) => void; note: string }) {
  if (!range) return null;
  const b = bounds(range);
  const low = offer < range.minCents;
  return (
    <Card style={{ borderColor: C.brand }}>
      <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 20, textAlign: 'center' }}>¿Cuánto quieres pagar?</Text>
      <Stepper valueCents={offer} onChange={setOffer} minCents={b.min} maxCents={b.max} />
      <P muted center>
        Precio justo sugerido: {money(range.minCents)} – {money(range.maxCents)}
      </P>
      {low ? <P center style={{ color: C.brand2 }}>Una oferta baja puede tardar más o no ser aceptada.</P> : null}
      <P muted center>{note}</P>
    </Card>
  );
}

/** Grúa: origen (donde está tu vehículo), destino (taller), tipo y problema; tú ofertas y la primera grúa que acepta va. */
export function Tow() {
  const { api } = useSession();
  const nav = useNav();
  const [pickup, setPickup] = useState<Point | null>(null);
  const [dest, setDest] = useState<Point | null>(null);
  const [category, setCategory] = useState<(typeof TOW_CATEGORIES)[number]['value']>('auto');
  const [problem, setProblem] = useState<(typeof PROBLEMS)[number]['value']>('no_enciende');
  const [notes, setNotes] = useState('');
  const [range, setRange] = useState<Range | null>(null);
  const [offer, setOffer] = useState(0);
  const { busy, error, setError, run } = useAction();

  useEffect(() => void currentLocation().then((f) => f && setPickup({ label: 'Mi ubicación', at: f })), []);
  useEffect(() => {
    setRange(null);
    if (pickup && dest)
      void api.assistSuggest({ kind: 'tow', pickup: pickup.at, destination: dest.at, vehicleCategory: category }).then((r) => (setRange(r), setOffer(roundUp((r.minCents + r.maxCents) / 2))), (e) => setError(String(e.message)));
  }, [pickup, dest, category]);

  const placeOptions = PLACES.map((p) => ({ value: p.name, label: p.name }));
  const pick = (name: string) => PLACES.find((p) => p.name === name)!;
  return (
    <Screen title="Grúa">
      <TripMap markers={[...(pickup ? [{ id: 'p', title: 'Tu vehículo', ...pickup.at }] : []), ...(dest ? [{ id: 'd', title: 'Destino', ...dest.at, color: 'gold' }] : [])]} />
      <Card>
        <P style={{ fontWeight: '700' }}>¿Dónde está tu vehículo? {pickup?.label ?? ''}</P>
        <Choice value={pickup?.label ?? ''} options={[{ value: 'Mi ubicación', label: 'Mi ubicación' }, ...placeOptions]} onChange={async (v) => {
          if (v !== 'Mi ubicación') return setPickup({ label: v, at: pick(v).at });
          const f = await currentLocation();
          f ? setPickup({ label: v, at: f }) : setError('Permite el acceso a tu ubicación o elige un lugar');
        }} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>¿A dónde lo llevamos? {dest?.label ?? ''}</P>
        <Choice value={dest?.label ?? ''} options={placeOptions} onChange={(v) => setDest({ label: v, at: pick(v).at })} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Tipo de vehículo</P>
        <Choice value={category} onChange={setCategory} options={[...TOW_CATEGORIES]} />
        <P style={{ fontWeight: '700' }}>¿Qué pasó?</P>
        <Choice value={problem} onChange={setProblem} options={[...PROBLEMS]} />
        <Field label="Detalles (opcional)" value={notes} onChangeText={setNotes} maxLength={500} />
        {problem === 'choque' ? <P style={{ color: C.brand2 }}>Si hay personas heridas, usa primero el SOS o llama al 911.</P> : null}
      </Card>
      <OfferCard range={range} offer={offer} setOffer={setOffer} note="La primera grúa verificada que acepte tu oferta va por tu vehículo. Pago en efectivo al terminar." />
      <ErrorText error={error} />
      <Button label={range ? `Pedir grúa por ${money(offer)}` : 'Elige origen y destino'} disabled={!range} loading={busy} onPress={() => run(async () => {
        const r = await api.assistRequest({ kind: 'tow', pickup: pickup!.at, destination: dest!.at, pickupLabel: pickup!.label, destinationLabel: dest!.label, vehicleCategory: category, problem, notes: notes.trim() || undefined, offerCents: offer });
        nav.replace('assist', { id: r.id });
      })} />
    </Screen>
  );
}

const today = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10); // fecha en Guayaquil (UTC−5)
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

/** Alquiler: tipo de vehículo, fecha y días; ofertas lo que quieres pagar y el primer arrendador que acepta te lo entrega. */
export function Rental() {
  const { api } = useSession();
  const nav = useNav();
  const [pickup, setPickup] = useState<Point | null>(null);
  const [category, setCategory] = useState<(typeof RENTAL_CATEGORIES)[number]['value']>('auto');
  const [start, setStart] = useState(addDays(today(), 1));
  const [days, setDays] = useState(1);
  const [notes, setNotes] = useState('');
  const [range, setRange] = useState<Range | null>(null);
  const [offer, setOffer] = useState(0);
  const { busy, error, setError, run } = useAction();

  useEffect(() => void currentLocation().then((f) => f && setPickup({ label: 'Mi ubicación', at: f })), []);
  useEffect(() => {
    setRange(null);
    void api.assistSuggest({ kind: 'rental', vehicleCategory: category, days }).then((r) => (setRange(r), setOffer(roundUp((r.minCents + r.maxCents) / 2))), (e) => setError(String(e.message)));
  }, [category, days]);

  const placeOptions = PLACES.map((p) => ({ value: p.name, label: p.name }));
  const dateOptions = [0, 1, 2, 3, 7].map((n) => ({ value: addDays(today(), n), label: n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : addDays(today(), n).slice(5).split('-').reverse().join('/') }));
  return (
    <Screen title="Alquiler de vehículo">
      <Card>
        <P style={{ fontWeight: '700' }}>¿Qué vehículo necesitas?</P>
        <Choice value={category} onChange={setCategory} options={[...RENTAL_CATEGORIES]} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>¿Desde cuándo?</P>
        <Choice value={start} onChange={setStart} options={dateOptions} />
        <P style={{ fontWeight: '700' }}>Días: {days}</P>
        <Row style={{ gap: 10 }}>
          <Button label="−" kind="secondary" disabled={days <= 1} onPress={() => setDays(days - 1)} />
          <Button label="+" kind="secondary" disabled={days >= 30} onPress={() => setDays(days + 1)} />
          {days >= 7 ? <P muted>10 % menos por 7 días o más</P> : null}
        </Row>
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>¿Dónde lo recibes? {pickup?.label ?? ''}</P>
        <Choice value={pickup?.label ?? ''} options={[...(pickup?.label === 'Mi ubicación' ? [{ value: 'Mi ubicación', label: 'Mi ubicación' }] : []), ...placeOptions]} onChange={(v) => v !== 'Mi ubicación' && setPickup({ label: v, at: PLACES.find((p) => p.name === v)!.at })} />
        <Field label="Notas (opcional)" value={notes} onChangeText={setNotes} maxLength={500} />
      </Card>
      <OfferCard range={range} offer={offer} setOffer={setOffer} note="Necesitas tu identidad verificada y licencia vigente. El arrendador revisa tu licencia y firma contigo el contrato al entregar." />
      <ErrorText error={error} />
      <Button label={range ? `Ofertar ${money(offer)} por ${days} día(s)` : 'Calculando…'} disabled={!range || !pickup} loading={busy} onPress={() => run(async () => {
        const r = await api.assistRequest({ kind: 'rental', pickup: pickup!.at, pickupLabel: pickup!.label, vehicleCategory: category, startDate: start, days, notes: notes.trim() || undefined, offerCents: offer });
        nav.replace('assist', { id: r.id });
      })} />
    </Screen>
  );
}

const STATUS: Record<AssistView['status'], string> = {
  open: 'Buscando quién acepte tu oferta…',
  accepted: 'Aceptado',
  arrived: 'Llegó al punto de encuentro',
  in_progress: 'En curso',
  completed: 'Terminado',
  cancelled: 'Cancelado',
  expired: 'Nadie aceptó a tiempo',
};

/** Estado de una solicitud de grúa o alquiler: subir la oferta, cancelar, ver al proveedor y calificar. */
export function AssistStatus({ id }: { id: string }) {
  const { api } = useSession();
  const nav = useNav();
  const [a, setA] = useState<AssistView | null>(null);
  const [raise, setRaise] = useState(0);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api.assist(id).then((r) => (setA(r), setRaise((v) => Math.max(v, r.offerCents)))), [id]);

  useEffect(() => {
    void run(load);
    const t = setInterval(() => void load().catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [id]);
  if (!a) return <Screen title="Solicitud">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;

  const title = a.kind === 'tow' ? 'Grúa' : 'Alquiler';
  const cancel = () =>
    Alert.alert('¿Cancelar la solicitud?', a.status === 'open' ? undefined : 'El proveedor ya va en camino.', [
      { text: 'No' },
      { text: 'Sí, cancelar', style: 'destructive', onPress: () => void run(async () => (await api.assistCancel(id), await load())) },
    ]);
  return (
    <Screen title={title}>
      <H>{STATUS[a.status]}</H>
      {a.kind === 'tow' ? (
        <TripMap
          markers={[
            { id: 'p', title: 'Tu vehículo', ...a.pickup },
            ...(a.destination ? [{ id: 'd', title: 'Destino', ...a.destination, color: 'gold' }] : []),
            ...(a.providerLocation ? [{ id: 'g', title: 'Grúa', ...a.providerLocation, color: 'blue' }] : []),
          ]}
        />
      ) : null}
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <P>Tu oferta</P>
          <Text style={{ color: C.brand2, fontSize: 24, fontWeight: '700' }}>{money(a.offerCents)}</Text>
        </Row>
        <P muted>
          {a.kind === 'tow' ? `${a.pickup.label ?? 'Origen'} → ${a.destination?.label ?? 'destino'} · ${a.vehicleCategory}` : `${a.vehicleCategory} · desde ${a.startDate} · ${a.days} día(s)`}
        </P>
        {a.expiresAt ? <P muted>La oferta vence a las {new Date(a.expiresAt).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}</P> : null}
      </Card>
      {a.status === 'open' ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Nadie acepta? Sube tu oferta</P>
          <Stepper valueCents={raise} onChange={setRaise} minCents={a.offerCents} maxCents={a.suggested.maxCents * 3} />
          <Button label={`Subir a ${money(raise)}`} kind="secondary" disabled={raise <= a.offerCents} loading={busy} onPress={() => run(async () => setA(await api.assistRaise(id, raise)))} />
        </Card>
      ) : null}
      {a.provider ? <DriverProfile driver={a.provider} title={a.kind === 'tow' ? 'Tu grúa' : 'Tu arrendador'} /> : null}
      {a.status === 'completed' && !a.rating ? (
        <Card>
          <P style={{ fontWeight: '700' }}>¿Cómo te fue?</P>
          <Choice<string> value="" onChange={(v) => void run(async () => (await api.assistRate(id, Number(v)), await load()))} options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: '★'.repeat(n) }))} />
        </Card>
      ) : null}
      {a.status === 'completed' ? <P muted>Pago en efectivo directamente al proveedor: {money(a.offerCents)}.</P> : null}
      {['open', 'accepted', 'arrived'].includes(a.status) ? <Button label="Cancelar solicitud" kind="secondary" onPress={cancel} /> : null}
      {['completed', 'cancelled', 'expired'].includes(a.status) ? <Button label="Volver al inicio" onPress={() => nav.reset('home')} /> : null}
      <ErrorText error={error} />
    </Screen>
  );
}
