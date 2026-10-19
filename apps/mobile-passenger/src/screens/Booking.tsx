import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';
import { money, type BookingView } from '@intitaxi/mobile-core';
import { Security } from '@intitaxi/mobile-security';
import { useSession } from '../lib/session-context';
import { Button, C, Card, ErrorText, H, Loading, P, Screen, useAction } from '../ui/kit';
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

  if (!b) return <Screen title="Mi reserva">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  return (
    <Screen title="Mi reserva">
      <H>{LABEL[b.status]}</H>
      <Card>
        <P>
          {b.boardingStop} → {b.alightingStop} · {b.seats} asiento(s)
        </P>
        <P>
          {b.vehicle.make} {b.vehicle.model} {b.vehicle.color} · placa <Text style={{ fontWeight: '700' }}>{b.vehicle.plate}</Text>
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
