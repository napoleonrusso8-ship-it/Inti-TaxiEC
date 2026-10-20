import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { money } from '@intitaxi/mobile-core';
import { useSession } from '../lib/session-context';
import { Button, C, Card, ErrorText, Loading, P, Row, Screen, SERIF, Stepper, useAction } from '../ui/kit';

type Loyalty = Awaited<ReturnType<ReturnType<typeof useSession>['api']['loyalty']>>;
const KIND: Record<string, string> = { trip: 'Viaje', route: 'Taxi Ruta', redeem: 'Canje', rating_bonus: 'Bonificación', adjustment: 'Ajuste', expire: 'Vencimiento' };

/** Inti Puntos: 1 punto por cada dólar pagado; 100 puntos = $1 de crédito en la billetera. */
export function Points() {
  const { api } = useSession();
  const [l, setL] = useState<Loyalty | null>(null);
  const [amount, setAmount] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = () => run(async () => {
    const r = await api.loyalty();
    setL(r);
    setAmount(Math.min(r.points - (r.points % r.rules.redeemUnit), r.rules.monthlyMax));
  });
  useEffect(() => void load(), []);
  if (!l) return <Screen title="Inti Puntos">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;

  const max = Math.min(l.points - (l.points % l.rules.redeemUnit), l.rules.monthlyMax);
  const canRedeem = max >= l.rules.redeemMin;
  return (
    <Screen title="Inti Puntos">
      <Card style={{ alignItems: 'center', borderColor: C.brand }}>
        <Text style={{ color: C.brand2, fontFamily: SERIF, fontSize: 44 }}>✦ {l.points.toLocaleString('es-EC')}</Text>
        <P muted>equivalen a {money(l.valueCents)} en viajes</P>
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Canjear</P>
        {canRedeem ? (
          <>
            <Stepper valueCents={amount} onChange={setAmount} stepCents={l.rules.redeemUnit} minCents={l.rules.redeemMin} maxCents={max} />
            <P muted center>
              {amount} puntos → {money(amount)} de crédito
            </P>
            <Button label="Canjear a mi billetera" loading={busy} onPress={() => run(async () => {
              const r = await api.redeem(amount);
              setInfo(`Listo: ${money(r.creditedCents)} en tu billetera`);
              await load();
            })} />
          </>
        ) : (
          <P muted>Puedes canjear desde {l.rules.redeemMin} puntos (máximo {l.rules.monthlyMax} al mes).</P>
        )}
      </Card>
      {info ? <P>{info}</P> : null}
      <Card>
        <P style={{ fontWeight: '700' }}>Movimientos</P>
        {l.history.length === 0 ? <P muted>Aún no tienes movimientos.</P> : null}
        {l.history.map((h, i) => (
          <Row key={i} style={{ justifyContent: 'space-between' }}>
            <P>{KIND[h.kind] ?? h.kind}</P>
            <P style={{ color: h.points >= 0 ? C.ok : C.muted }}>
              {h.points > 0 ? '+' : ''}
              {h.points} · {new Date(h.at).toLocaleDateString('es-EC')}
            </P>
          </Row>
        ))}
      </Card>
      <P muted>Los puntos no son dinero ni se pueden transferir. Ganas puntos por viajes pagados y completados.</P>
      <ErrorText error={error} />
    </Screen>
  );
}
