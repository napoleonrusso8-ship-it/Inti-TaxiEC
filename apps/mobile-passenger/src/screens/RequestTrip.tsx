import { useEffect, useState } from 'react';
import { Switch } from 'react-native';
import { money, PLACES, type LatLng, type PaymentMethod } from '@intitaxi/mobile-core';
import { TripMap } from '../components/Map';
import { CompanionsEditor, emptyPerson, PersonFields, personProblem, toPerson, type PersonDraft } from '../components/PeopleForm';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, Card, Choice, ErrorText, P, Row, useAction } from '../ui/kit';

type Point = { label: string; at: LatLng };

/** Pedir un taxi: origen (GPS o lugar), destino, quiénes viajan, pago, cotización y solicitud. */
export function RequestTrip() {
  const { api, risk } = useSession();
  const nav = useNav();
  const [origin, setOrigin] = useState<Point | null>(null);
  const [dest, setDest] = useState<Point | null>(null);
  const [mockedGps, setMockedGps] = useState(false);
  const [companions, setCompanions] = useState<PersonDraft[]>([]);
  const [forOther, setForOther] = useState(false);
  const [third, setThird] = useState<PersonDraft>(emptyPerson());
  const [payment, setPayment] = useState<PaymentMethod>('cash');
  const [quote, setQuote] = useState<{ quoteId: string; fareCents: number; distanceM: number; durationS: number } | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    void currentLocation().then((fix) => {
      if (!fix) return;
      setMockedGps(fix.mocked);
      setOrigin({ label: 'Mi ubicación', at: fix });
    });
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
      const t = await api.requestTrip({
        quoteId: quote!.quoteId,
        paymentMethod: payment,
        companions: companions.map(toPerson),
        forThirdParty: forOther ? toPerson(third) : undefined,
      });
      nav.push('trip', { tripId: t.id });
    });
  };

  const placeOptions = PLACES.map((p) => ({ value: p.name, label: p.name }));
  const pick = (name: string) => PLACES.find((p) => p.name === name)!;
  return (
    <>
      {mockedGps ? <P style={{ color: '#B42318' }}>Tu teléfono usa una ubicación simulada. Desactívala para pedir un taxi con tu posición real.</P> : null}
      <TripMap markers={[...(origin ? [{ id: 'o', title: 'Origen', ...origin.at }] : []), ...(dest ? [{ id: 'd', title: 'Destino', ...dest.at, color: 'green' }] : [])]} />
      <Card>
        <P style={{ fontWeight: '700' }}>Origen: {origin?.label ?? 'elige un lugar'}</P>
        <Choice value={origin?.label ?? ''} options={[{ value: 'Mi ubicación', label: 'Mi ubicación' }, ...placeOptions]} onChange={async (v) => {
          if (v === 'Mi ubicación') {
            const fix = await currentLocation();
            if (fix) (setMockedGps(fix.mocked), setOrigin({ label: v, at: fix }));
            else setError('Permite el acceso a tu ubicación o elige un lugar');
          } else setOrigin({ label: v, at: pick(v).at });
        }} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Destino: {dest?.label ?? 'elige un lugar'}</P>
        <Choice value={dest?.label ?? ''} options={placeOptions} onChange={(v) => setDest({ label: v, at: pick(v).at })} />
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
        <Card>
          <P>
            Tarifa estimada: <P style={{ fontWeight: '700' }}>{money(quote.fareCents)}</P> · {(quote.distanceM / 1000).toFixed(1)} km · {Math.round(quote.durationS / 60)} min
          </P>
          <Button label="Pedir taxi" kind="brand" onPress={request} loading={busy} />
        </Card>
      ) : (
        <Button label="Ver tarifa" onPress={getQuote} loading={busy} disabled={!origin || !dest} />
      )}
      <ErrorText error={error} />
    </>
  );
}
