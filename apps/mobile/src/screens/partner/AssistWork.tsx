import { useCallback, useEffect, useState } from 'react';
import { Linking, Text } from 'react-native';
import { money, type AssistOpen, type PartnerProfile } from '@intitaxi/mobile-core';
import { TripMap } from '../../components/Map';
import { useNav } from '../../lib/nav';
import { usePartner } from '../../lib/session-context';
import { Button, C, Card, Choice, Empty, ErrorText, Loading, P, Pill, Row, Screen, Section, useAction } from '../../ui/kit';

const PROBLEM: Record<string, string> = { no_enciende: 'No enciende', choque: 'Choque', llanta: 'Llanta', sin_combustible: 'Sin combustible', otro: 'Otro' };

/**
 * Pedidos de grúa o de alquiler: el usuario oferta y el PRIMER socio que acepta se queda con el servicio.
 * Antes de aceptar solo se ve la zona aproximada; la dirección exacta y el contacto llegan al aceptar.
 */
export function AssistWork({ kind }: { kind: 'tow' | 'rental' }) {
  const { api } = usePartner();
  const nav = useNav();
  const [list, setList] = useState<AssistOpen[] | null>(null);
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [vehicleId, setVehicleId] = useState('');
  const { busy, error, run } = useAction();

  const load = useCallback(() => api.assistOpen(kind).then(setList), [kind]);
  useEffect(() => {
    void run(async () => {
      const p = await api.profile();
      setProfile(p);
      setVehicleId(p.vehicles.find((v) => v.status === 'approved' && v.vehicle_type === kind)?.id ?? '');
      await load();
    });
    const t = setInterval(() => void load().catch(() => {}), 6000);
    return () => clearInterval(t);
  }, [kind]);

  const vehicles = profile?.vehicles.filter((v) => v.status === 'approved' && v.vehicle_type === kind) ?? [];
  return (
    <Screen title={kind === 'tow' ? 'Pedidos de grúa' : 'Solicitudes de alquiler'} subtitle="El primero que acepta se queda con el servicio">
      {vehicles.length > 1 ? <Choice value={vehicleId} onChange={setVehicleId} options={vehicles.map((v) => ({ value: v.id, label: v.plate }))} /> : null}
      {list === null ? error ? <ErrorText error={error} /> : <Loading /> : null}
      {list?.length === 0 ? <Empty icon={kind === 'tow' ? '🛻' : '🔑'} title="No hay solicitudes ahora" text={kind === 'tow' ? 'Mantente conectado con tu grúa para ver pedidos cercanos.' : 'Te mostramos las de tus categorías de vehículo.'} /> : null}
      {list?.map((r) => (
        <Card key={r.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ color: C.brand2, fontSize: 26, fontWeight: '700' }}>{money(r.offerCents)}</Text>
            <Pill tone={r.offerCents >= r.suggested.minCents ? 'ok' : 'muted'}>{r.offerCents >= r.suggested.minCents ? 'Oferta justa' : 'Oferta baja'}</Pill>
          </Row>
          <P muted>
            Sugerido {money(r.suggested.minCents)} – {money(r.suggested.maxCents)}
          </P>
          {kind === 'tow' ? (
            <P>
              {PROBLEM[r.problem ?? ''] ?? 'Asistencia'} · {r.vehicleCategory}
              {r.distanceToPickupM !== null ? ` · a ${(r.distanceToPickupM / 1000).toFixed(1)} km` : ''}
              {r.tripDistanceM ? ` · remolque de ${(r.tripDistanceM / 1000).toFixed(1)} km` : ''}
            </P>
          ) : (
            <P>
              {r.vehicleCategory} · desde {r.startDate} · {r.days} día(s)
            </P>
          )}
          <Button
            label="Aceptar"
            disabled={!vehicleId}
            loading={busy}
            onPress={() =>
              run(async () => {
                const a = await api.assistAccept(r.id, vehicleId);
                nav.replace('partner.assistJob', { id: a.id });
              })
            }
          />
        </Card>
      ))}
      <ErrorText error={list ? error : null} />
    </Screen>
  );
}

const NEXT: Record<string, { step: 'arrived' | 'in_progress' | 'completed'; label: string } | undefined> = {
  accepted: { step: 'arrived', label: 'Llegué al punto de encuentro' },
  arrived: { step: 'in_progress', label: 'Iniciar servicio' },
  in_progress: { step: 'completed', label: 'Terminar servicio' },
};

/** Servicio aceptado: dirección exacta, avance por pasos y cobro en efectivo. */
export function AssistJob({ id }: { id: string }) {
  const { api } = usePartner();
  const nav = useNav();
  const [a, setA] = useState<Awaited<ReturnType<typeof api.assist>> | null>(null);
  const { busy, error, run } = useAction();
  const load = () => api.assist(id).then(setA);
  useEffect(() => void run(load), [id]);
  if (!a) return <Screen title="Servicio">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  const next = NEXT[a.status];
  const target = a.status === 'in_progress' && a.destination ? a.destination : a.pickup;
  return (
    <Screen title={a.kind === 'tow' ? 'Servicio de grúa' : 'Alquiler'} subtitle={`${money(a.offerCents)} · efectivo al terminar`}>
      <TripMap markers={[{ id: 'p', title: 'Encuentro', ...a.pickup }, ...(a.destination ? [{ id: 'd', title: 'Destino', ...a.destination, color: 'gold' }] : [])]} />
      <Card>
        <P style={{ fontWeight: '700' }}>{a.pickup.label ?? 'Punto de encuentro'}</P>
        {a.destination ? <P muted>Hasta: {a.destination.label ?? 'destino'}</P> : null}
        {a.kind === 'rental' ? <P muted>Desde {a.startDate} · {a.days} día(s) · {a.vehicleCategory}</P> : null}
        {a.notes ? <P muted>Notas: {a.notes}</P> : null}
        {a.kind === 'rental' ? <P muted>Antes de entregar: revisa la licencia vigente del cliente y firma el contrato con el estado del vehículo.</P> : null}
      </Card>
      <Button label="🧭 Navegar" kind="secondary" onPress={() => void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}`)} />
      {next ? <Button label={next.label} loading={busy} onPress={() => run(async () => setA({ ...a, ...(await api.assistStep(id, next.step)) }))} /> : null}
      {a.status === 'completed' ? (
        <Card>
          <Section>Terminado</Section>
          <P>Cobra {money(a.offerCents)} en efectivo. La comisión de Inti Taxi se descuenta de tu saldo.</P>
        </Card>
      ) : null}
      {a.status === 'cancelled' ? <P style={{ color: C.danger }}>El cliente canceló el servicio.</P> : null}
      {['completed', 'cancelled'].includes(a.status) ? <Button label="Volver" onPress={() => nav.reset('work')} /> : null}
      <ErrorText error={error} />
      <Button label="Actualizar" kind="ghost" small onPress={() => void run(load)} />
      {a.status === 'accepted' ? <P muted center>Si no puedes llegar, avisa al cliente cuanto antes desde soporte.</P> : null}
    </Screen>
  );
}

