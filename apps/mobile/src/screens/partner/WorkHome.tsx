import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, issueLabel, money, PARTNER_KINDS, type Offer, type PartnerProfile, type PartnerVehicle } from '@intitaxi/mobile-core';
import { TripMap } from '../../components/Map';
import { useNav } from '../../lib/nav';
import { usePartner, useSession } from '../../lib/session-context';
import { workLocation } from '../../lib/work-location';
import { Button, C, Card, Choice, Empty, ErrorText, ListItem, Loading, P, Pill, Row, Section, Segmented, Stat, TabBar, useAction } from '../../ui/kit';
import { PartnerSetup, VehicleCard } from './Setup';

type Tab = 'inicio' | 'ganancias' | 'cuenta';
const PREF_LABEL: Record<string, string> = { quiet: '🤫 Silencio', ac: '❄ A/C', luggage: '🧳 Equipaje', pet: '🐾 Mascota', wheelchair: '♿ Accesible' };

/** Inicio del modo Trabajar: estado del registro, conexión, ofertas, rutas y pedidos según el perfil del socio. */
export function WorkHome() {
  const session = useSession();
  const { api } = session.partner;
  const nav = useNav();
  const [tab, setTab] = useState<Tab>('inicio');
  const [profile, setProfile] = useState<PartnerProfile | null | undefined>(undefined);
  const { error, run } = useAction();

  const load = useCallback(
    () =>
      run(async () => {
        await session.partner.ensure();
        setProfile(await api.profile().catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))));
      }),
    [],
  );
  useEffect(() => void load(), []);
  // Si quedó un viaje o una ruta en curso (la app se cerró), se retoma.
  useEffect(() => {
    if (profile?.status !== 'approved') return;
    void api
      .current()
      .then((c) => {
        if (c && 'routeInstanceId' in c) nav.push('partner.routes');
        else if (c && 'id' in c && ['accepted', 'arrived', 'in_progress'].includes(c.status)) nav.push('partner.trip', { tripId: c.id });
      })
      .catch(() => {});
  }, [profile?.status]);

  const toRide = async () => {
    if (workLocation.active) {
      workLocation.stop();
      await api.offline().catch(() => {});
    }
    await session.mode.set('ride');
    nav.reset('home');
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaView edges={['top']} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 12 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={{ color: C.brand, fontSize: 13, letterSpacing: 4, fontWeight: '700' }}>☀ INTI · SOCIOS</Text>
          {profile ? <Text style={{ color: C.muted, fontSize: 12 }}>{PARTNER_KINDS.find((k) => k.kind === profile.partnerKind)?.title}</Text> : null}
        </Row>
        <Segmented value="work" onChange={(v) => v === 'ride' && void toRide()} options={[{ value: 'ride', label: 'Viajar' }, { value: 'work', label: 'Trabajar' }]} />
      </SafeAreaView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, gap: 14 }} keyboardShouldPersistTaps="handled">
        {profile === undefined ? error ? <ErrorText error={error} /> : <Loading /> : null}
        {profile === null ? (
          <Card>
            <Empty icon="🤝" title="Aún no eres socio" text="Elige cómo quieres trabajar con Inti Taxi." />
            <Button label="Elegir mi perfil" onPress={() => nav.push('partner.join')} />
          </Card>
        ) : null}
        {profile && tab === 'inicio' ? (
          profile.status === 'approved' ? <Approved profile={profile} reload={load} /> : <PartnerSetup profile={profile} reload={load} />
        ) : null}
        {profile && tab === 'ganancias' ? <Earnings /> : null}
        {profile && tab === 'cuenta' ? <PartnerAccount profile={profile} onRide={() => void toRide()} /> : null}
        <ErrorText error={profile !== undefined ? error : null} />
      </ScrollView>
      {profile ? (
        <TabBar
          value={tab}
          onChange={(t) => (setTab(t), void load())}
          tabs={[
            { id: 'inicio', icon: '◉', label: 'Trabajo' },
            { id: 'ganancias', icon: '＄', label: 'Ganancias' },
            { id: 'cuenta', icon: '☰', label: 'Cuenta' },
          ]}
        />
      ) : null}
    </View>
  );
}

function Approved({ profile, reload }: { profile: PartnerProfile; reload: () => unknown }) {
  const nav = useNav();
  const k = profile.partnerKind;
  const onDemand = k === 'taxi_driver' || k === 'route_taxi_owner' || k === 'tow_operator';
  return (
    <>
      {profile.issues?.length ? (
        <Card style={{ borderColor: C.danger }}>
          <P style={{ color: C.danger, fontWeight: '700' }}>No puedes conectarte todavía</P>
          {profile.issues.map((i) => (
            <P key={i} muted>
              • {issueLabel(i)}
            </P>
          ))}
        </Card>
      ) : null}
      {onDemand ? <OnlinePanel profile={profile} towOnly={k === 'tow_operator'} /> : null}
      {k === 'route_taxi_owner' || k === 'van_owner' ? (
        <Card onPress={() => nav.push('partner.routes')}>
          <ListItem icon="🛣️" title="Taxi Ruta" subtitle={k === 'van_owner' ? 'Rutas fijas con tu furgoneta: pide habilitación, inicia recorridos y sube pasajeros con su PIN' : 'Rutas fijas con tu taxi amarillo'} />
        </Card>
      ) : null}
      {k === 'tow_operator' ? (
        <Card onPress={() => nav.push('partner.assist', { kind: 'tow' })}>
          <ListItem icon="🛻" title="Pedidos de grúa" subtitle="Ofertas de usuarios cerca de ti. El primero que acepta gana." />
        </Card>
      ) : null}
      {k === 'rental_company' ? (
        <Card onPress={() => nav.push('partner.assist', { kind: 'rental' })}>
          <ListItem icon="🔑" title="Solicitudes de alquiler" subtitle="Ofertas de usuarios para tus categorías de vehículo" />
        </Card>
      ) : null}
      <Section>Mis vehículos</Section>
      {profile.vehicles.map((v) => (
        <VehicleCard key={v.id} v={v} />
      ))}
      <Button label="Actualizar" kind="ghost" small onPress={() => void reload()} />
    </>
  );
}

/** Conectarse con un vehículo aprobado, compartir ubicación y recibir ofertas. */
function OnlinePanel({ profile, towOnly }: { profile: PartnerProfile; towOnly: boolean }) {
  const { api } = usePartner();
  const nav = useNav();
  const vehicles = profile.vehicles.filter((v) => v.status === 'approved' && (towOnly ? v.vehicle_type === 'tow' : v.vehicle_type === 'taxi'));
  const [vehicleId, setVehicleId] = useState<string>(vehicles[0]?.id ?? '');
  const [online, setOnline] = useState(workLocation.active);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [now, setNow] = useState(Date.now());
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!online || towOnly) return;
    const t = setInterval(() => {
      setNow(Date.now());
      void api.offers().then(setOffers).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [online]);

  const goOnline = () =>
    run(async () => {
      const here = await workLocation.current();
      if (!here) return setError('Permite la ubicación para conectarte');
      if (here.mocked) return setError('Tu teléfono usa una ubicación simulada. Desactívala para trabajar.');
      await api.online(vehicleId, { lat: here.lat, lng: here.lng });
      await workLocation.start(api);
      setOnline(true);
    });
  const goOffline = () =>
    run(async () => {
      workLocation.stop();
      await api.offline();
      setOnline(false);
      setOffers([]);
    });
  const accept = (o: Offer) =>
    run(async () => {
      const r = await api.accept(o.offerId);
      setOffers([]);
      nav.push('partner.trip', { tripId: r.tripId });
    });

  if (!vehicles.length) return <Card><P muted>Necesitas un {towOnly ? 'vehículo grúa' : 'taxi'} aprobado para conectarte.</P></Card>;
  const here = workLocation.last;
  return (
    <>
      <Card style={{ borderColor: online ? C.ok : C.line }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Text style={{ color: C.ink, fontSize: 20, fontWeight: '700' }}>{online ? 'Conectado' : 'Desconectado'}</Text>
            <P muted>{online ? (towOnly ? 'Te avisaremos de pedidos de grúa cercanos' : 'Buscando viajes cerca de ti…') : 'Conéctate para recibir viajes'}</P>
          </View>
          <Pill tone={online ? 'ok' : 'muted'}>{online ? '● En línea' : 'Fuera de línea'}</Pill>
        </Row>
        {!online && vehicles.length > 1 ? <Choice value={vehicleId} onChange={setVehicleId} options={vehicles.map((v: PartnerVehicle) => ({ value: v.id, label: v.plate }))} /> : null}
        <Button label={online ? 'Desconectarme' : 'Conectarme'} kind={online ? 'secondary' : 'primary'} onPress={() => void (online ? goOffline() : goOnline())} loading={busy} />
        <P muted>La ubicación se comparte solo mientras estás conectado y con la app abierta.</P>
      </Card>
      {online && here ? <TripMap height={180} markers={[{ id: 'me', title: 'Tú', lat: here.lat, lng: here.lng }]} /> : null}
      {online && !towOnly ? (
        offers.length === 0 ? (
          <Empty icon="📡" title="Esperando viajes" text="Las ofertas duran 15 segundos. Mantén la app abierta." />
        ) : (
          offers.map((o) => {
            const left = Math.max(0, Math.round((Date.parse(o.expiresAt) - now) / 1000));
            return (
              <Card key={o.offerId} style={{ borderColor: C.brand }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ color: C.brand2, fontSize: 28, fontWeight: '700' }}>{money(o.fareCents)}</Text>
                  <Pill>{left} s</Pill>
                </Row>
                {o.surgeCents > 0 ? <P style={{ color: C.ok }}>Incluye {money(o.surgeCents)} de tarifa dinámica (100 % para ti)</P> : null}
                <P>
                  Recogida a {(o.pickupDistanceM / 1000).toFixed(1)} km · viaje de {(o.tripDistanceM / 1000).toFixed(1)} km · {o.partySize} persona(s) · {o.paymentMethod === 'cash' ? 'efectivo' : 'pago en la app'}
                </P>
                <P muted>
                  Pasajero: {o.passengerRating ? `★ ${o.passengerRating}` : 'nuevo'} · {o.passengerTrips} viaje(s)
                </P>
                {Object.entries(o.prefs ?? {}).filter(([, v]) => v).length || o.ellxsOnly || o.allyOnly ? (
                  <P muted>
                    {[...Object.entries(o.prefs ?? {}).filter(([, v]) => v).map(([k]) => PREF_LABEL[k] ?? k), ...(o.ellxsOnly ? ['🌈 Ellxs'] : []), ...(o.allyOnly ? ['🤝 Aliado'] : [])].join(' · ')}
                  </P>
                ) : null}
                <Row>
                  <View style={{ flex: 1 }}>
                    <Button label="Rechazar" kind="secondary" onPress={() => void run(async () => (await api.reject(o.offerId), setOffers(offers.filter((x) => x.offerId !== o.offerId))))} />
                  </View>
                  <View style={{ flex: 2 }}>
                    <Button label="Aceptar" onPress={() => void accept(o)} loading={busy} />
                  </View>
                </Row>
              </Card>
            );
          })
        )
      ) : null}
      <ErrorText error={error} />
    </>
  );
}

function Earnings() {
  const { api } = usePartner();
  const [e, setE] = useState<Awaited<ReturnType<typeof api.earnings>> | null>(null);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setE(await api.earnings())), []);
  if (!e) return error ? <ErrorText error={error} /> : <Loading />;
  const today = new Date().toDateString();
  const todayCents = e.trips.filter((t) => new Date(t.endedAt).toDateString() === today).reduce((a, t) => a + (t.fareCents ?? 0), 0);
  return (
    <>
      <Row>
        <Stat label="Disponible" value={money(e.availableCents)} tone={e.availableCents >= 0 ? 'ok' : undefined} />
        <Stat label="Hoy (cobrado)" value={money(todayCents)} />
      </Row>
      {e.note ? <P muted>{e.note}</P> : null}
      <Section>Últimos viajes</Section>
      {e.trips.length === 0 ? <Empty icon="🧾" title="Sin viajes todavía" /> : null}
      {e.trips.map((t) => (
        <ListItem key={t.tripId} icon={t.paymentMethod === 'cash' ? '💵' : '💳'} title={money(t.fareCents)} subtitle={`${new Date(t.endedAt).toLocaleString('es-EC')} · ${t.paymentMethod === 'cash' ? 'efectivo' : 'en la app'}`} />
      ))}
      {e.payouts.length ? <Section>Retiros</Section> : null}
      {e.payouts.map((p) => (
        <ListItem key={p.id} icon="🏦" title={money(p.amountCents)} subtitle={`${p.status} · ${new Date(p.requestedAt).toLocaleDateString('es-EC')}`} />
      ))}
      <P muted>Los retiros a tu cuenta bancaria se piden desde aquí cuando tengas saldo; exigen confirmar con tu passkey.</P>
    </>
  );
}

function PartnerAccount({ profile, onRide }: { profile: PartnerProfile; onRide: () => void }) {
  const session = useSession();
  const nav = useNav();
  const { api } = session.partner;
  const { error, run } = useAction();
  const drives = profile.partnerKind !== 'rental_company';
  return (
    <>
      {drives ? (
        <Card style={{ paddingVertical: 6 }}>
          <ListItem icon="🤝" title="Curso Conductor Aliado" subtitle="Formación en respeto e inclusión LGBTI. Te da la insignia Aliado." onPress={() => nav.push('partner.ally')} />
          <ListItem
            icon="🌈"
            title="Conductorx Ellxs"
            subtitle="Si eres mujer o parte de la comunidad LGBTI, pide atender viajes de Modo Ellxs. Lo aprueba un revisor."
            onPress={() =>
              Alert.alert('Conductorx Ellxs', 'Al pedirlo declaras que eres mujer o parte de la comunidad LGBTI. Un revisor de Inti Taxi lo aprueba; no se muestra a los pasajeros a qué grupo perteneces.', [
                { text: 'Cancelar', style: 'cancel' },
                { text: 'Pedirlo', onPress: () => void run(async () => (await api.requestEllxs(), Alert.alert('Solicitud enviada', 'Te avisaremos cuando un revisor la apruebe.'))) },
              ])
            }
          />
        </Card>
      ) : null}
      <Card style={{ paddingVertical: 6 }}>
        <ListItem icon="🚗" title="Agregar vehículo" onPress={() => nav.push('partner.vehicle', { types: profile.allowedVehicleTypes })} />
        <ListItem icon="🤝" title="Otro perfil de socio" subtitle="Cambia cómo trabajas con Inti Taxi" onPress={() => nav.push('partner.join')} />
        <ListItem icon="🙋" title="Volver a modo Viajar" onPress={onRide} />
      </Card>
      <Card style={{ paddingVertical: 6 }}>
        <ListItem icon="⎋" title="Cerrar sesión" danger onPress={() => void run(async () => (workLocation.stop(), await session.logoutAll(), nav.reset('login')))} />
      </Card>
      <ErrorText error={error} />
    </>
  );
}
