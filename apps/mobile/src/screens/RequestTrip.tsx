import { useEffect, useState } from 'react';
import { Switch, Text } from 'react-native';
import { money, PLACES, type LatLng, type PaymentMethod, type QuoteView, type TripPrefs } from '@intitaxi/mobile-core';
import { TripMap } from '../components/Map';
import { CompanionsEditor, emptyPerson, PersonFields, personProblem, toPerson, type PersonDraft } from '../components/PeopleForm';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, P, Row, Screen, SERIF, useAction } from '../ui/kit';

type Point = { label: string; at: LatLng };
const PREF_LABELS: { key: keyof TripPrefs; label: string }[] = [
  { key: 'quiet', label: '🤫 Silencio' },
  { key: 'ac', label: '❄ A/C' },
  { key: 'luggage', label: '🧳 Equipaje' },
  { key: 'pet', label: '🐾 Mascota' },
  { key: 'wheelchair', label: '♿ Accesible' },
];
const SURGE_REASON: Record<string, string> = { high_demand: 'Alta demanda en tu zona', no_drivers_nearby: 'Pocos conductores cerca' };

/** Pedir un taxi: origen, destino, quiénes viajan, preferencias, filtros, pago y precio cerrado con desglose. */
export function RequestTrip({ ellxsOnly: initialEllxs = false }: { ellxsOnly?: boolean }) {
  const { api, risk } = useSession();
  const nav = useNav();
  const [origin, setOrigin] = useState<Point | null>(null);
  const [dest, setDest] = useState<Point | null>(null);
  const [mockedGps, setMockedGps] = useState(false);
  const [companions, setCompanions] = useState<PersonDraft[]>([]);
  const [forOther, setForOther] = useState(false);
  const [third, setThird] = useState<PersonDraft>(emptyPerson());
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [prefs, setPrefs] = useState<TripPrefs>({});
  const [canEllxs, setCanEllxs] = useState(false);
  const [ellxsOnly, setEllxsOnly] = useState(initialEllxs);
  const [allyOnly, setAllyOnly] = useState(false);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    void currentLocation().then((fix) => {
      if (!fix) return;
      setMockedGps(fix.mocked);
      setOrigin({ label: 'Mi ubicación', at: fix });
    });
    void api.preferences().then((p) => (setPrefs(p.defaultPrefs ?? {}), setCanEllxs(p.ellxsMember))).catch(() => {});
  }, []);
  useEffect(() => setQuote(null), [origin, dest]);

  const getQuote = () =>
    run(async () => {
      if (!origin || !dest) throw new Error('Elige el origen y el destino');
      setQuote(await api.quote(origin.at, dest.at, origin.label, dest.label));
    });

  const request = () => {
    for (const [i, p] of companions.entries()) {
      const problem = personProblem(p);
      if (problem) return setError(`Acompañante ${i + 1}: ${problem}`);
    }
    if (forOther) {
      const problem = personProblem(third, { needsPhone: true });
      if (problem) return setError(`Pasajero: ${problem}`);
    }
    void run(async () => {
      const t = await api.requestTrip({ quoteId: quote!.quoteId, paymentMethod: payment, companions: companions.map(toPerson), forThirdParty: forOther ? toPerson(third) : undefined, prefs, ellxsOnly, allyOnly });
      nav.replace('trip', { tripId: t.id });
    });
  };

  const placeOptions = PLACES.map((p) => ({ value: p.name, label: p.name }));
  const pick = (name: string) => PLACES.find((p) => p.name === name)!;
  return (
    <Screen title={ellxsOnly ? 'Modo Ellxs' : 'Pedir taxi'} subtitle={ellxsOnly ? 'Solo conductorxs Ellxs verificadxs' : undefined}>
      {mockedGps ? <P style={{ color: C.danger }}>Tu teléfono usa una ubicación simulada. Desactívala para pedir un taxi con tu posición real.</P> : null}
      <TripMap markers={[...(origin ? [{ id: 'o', title: 'Origen', ...origin.at }] : []), ...(dest ? [{ id: 'd', title: 'Destino', ...dest.at, color: 'gold' }] : [])]} />
      <Card>
        <P style={{ fontWeight: '700' }}>Origen: {origin?.label ?? 'elige un lugar'}</P>
        <Choice
          value={origin?.label ?? ''}
          options={[{ value: 'Mi ubicación', label: 'Mi ubicación' }, ...placeOptions]}
          onChange={async (v) => {
            if (v === 'Mi ubicación') {
              const fix = await currentLocation();
              if (fix) (setMockedGps(fix.mocked), setOrigin({ label: v, at: fix }));
              else setError('Permite el acceso a tu ubicación o elige un lugar');
            } else setOrigin({ label: v, at: pick(v).at });
          }}
        />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Destino: {dest?.label ?? 'elige un lugar'}</P>
        <Choice value={dest?.label ?? ''} options={placeOptions} onChange={(v) => setDest({ label: v, at: pick(v).at })} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Preferencias del viaje</P>
        <Choice<string> value="" onChange={(k) => setPrefs({ ...prefs, [k]: !prefs[k as keyof TripPrefs] })} options={PREF_LABELS.map((p) => ({ value: p.key, label: `${p.label}${prefs[p.key] ? ' ✓' : ''}` }))} />
        <P muted>El conductor las ve antes de aceptar. Mascota y silla de ruedas solo se asignan a vehículos preparados.</P>
        {canEllxs ? (
          <Row>
            <Switch value={ellxsOnly} onValueChange={setEllxsOnly} thumbColor={ellxsOnly ? C.brand : undefined} />
            <P>🌈 Modo Ellxs: solo conductorxs Ellxs (mujeres y personas LGBTI)</P>
          </Row>
        ) : null}
        <Row>
          <Switch value={allyOnly} onValueChange={setAllyOnly} thumbColor={allyOnly ? C.brand : undefined} />
          <P>🌈 Solo Conductores Aliados (formación en inclusión)</P>
        </Row>
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>¿Quiénes viajan?</P>
        <Row>
          <Switch value={forOther} onValueChange={setForOther} />
          <P>El taxi es para otra persona (yo no viajo)</P>
        </Row>
        {forOther ? <PersonFields title="Pasajero principal" value={third} onChange={setThird} needsPhone /> : null}
        <CompanionsEditor people={companions} onChange={setCompanions} max={3} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Pago</P>
        <Choice<PaymentMethod>
          value={payment}
          onChange={setPayment}
          options={[{ value: 'cash', label: 'Efectivo' }, ...(risk.length ? [] : [{ value: 'card' as const, label: 'Tarjeta' }, { value: 'wallet' as const, label: 'Billetera' }])]}
        />
        {risk.length ? <P muted>Por seguridad de este dispositivo, solo está disponible el pago en efectivo.</P> : null}
      </Card>
      {quote ? (
        <Card style={{ borderColor: C.brand }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 20 }}>Precio cerrado</Text>
            <Text style={{ color: C.brand2, fontSize: 26, fontWeight: '700' }}>{money(quote.fareCents)}</Text>
          </Row>
          <P muted>
            {(quote.distanceM / 1000).toFixed(1)} km · {Math.round(quote.durationS / 60)} min
          </P>
          {quote.breakdown.surgeCents > 0 ? (
            <P muted>
              Tarifa {money(quote.breakdown.baseCents)} + {money(quote.breakdown.surgeCents)} ({SURGE_REASON[quote.breakdown.reason] ?? 'demanda'}, ×{quote.breakdown.multiplier}). El 100 % del extra es para el conductor.
            </P>
          ) : null}
          <Button label="Pedir taxi" kind="brand" onPress={request} loading={busy} />
        </Card>
      ) : (
        <Button label="Ver precio" onPress={getQuote} loading={busy} disabled={!origin || !dest} />
      )}
      <ErrorText error={error} />
    </Screen>
  );
}
