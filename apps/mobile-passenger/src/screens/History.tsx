import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { money, TRIP_STATUS } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Card, ErrorText, Loading, P, Screen, useAction } from '../ui/kit';

export function History() {
  const { api } = useSession();
  const nav = useNav();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.history>> | null>(null);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setRows(await api.history())), []);
  return (
    <Screen title="Mis viajes">
      {!rows ? <Loading /> : rows.length === 0 ? <P>Aún no tienes viajes.</P> : null}
      {rows?.map((t) => (
        <Pressable key={t.id} onPress={() => nav.push('trip', { tripId: t.id })}>
          <Card>
            <P style={{ fontWeight: '700' }}>{new Date(t.requestedAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</P>
            <P muted>
              {TRIP_STATUS[t.status] ?? t.status} · {money(t.finalFareCents ?? t.fareCents)}
            </P>
          </Card>
        </Pressable>
      ))}
      <ErrorText error={error} />
    </Screen>
  );
}
