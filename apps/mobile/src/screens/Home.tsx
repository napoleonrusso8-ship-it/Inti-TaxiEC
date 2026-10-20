import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { TripPrefs } from '@intitaxi/mobile-core';
import { TripMap } from '../components/Map';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, Choice, H, P, PrideBar, Row, Screen, Segmented, SERIF, TabBar } from '../ui/kit';
import { Account } from './Account';
import { HistoryList } from './History';

type Tab = 'inicio' | 'viajes' | 'cuenta';
const TABS: { id: Tab; icon: string; label: string; title?: string }[] = [
  { id: 'inicio', icon: '◉', label: 'Inicio' },
  { id: 'viajes', icon: '🧾', label: 'Mis viajes', title: 'Mis viajes' },
  { id: 'cuenta', icon: '☰', label: 'Cuenta', title: 'Mi cuenta' },
];

export function Home() {
  const { api } = useSession();
  const nav = useNav();
  const [tab, setTab] = useState<Tab>('inicio');

  // Si hay un viaje en curso (p. ej. la app se cerró), se retoma.
  useEffect(() => {
    void api
      .history()
      .then((rows) => {
        const active = rows.find((t) => ['matching', 'accepted', 'arrived', 'in_progress'].includes(t.status));
        if (active) nav.push('trip', { tripId: active.id });
      })
      .catch(() => {});
  }, []);

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1 }}>
        {tab === 'inicio' ? <Services /> : <Screen title={current.title}>{tab === 'viajes' ? <HistoryList /> : <Account />}</Screen>}
      </View>
      <TabBar tabs={TABS} value={tab} onChange={setTab} />
    </View>
  );
}

const SERVICES = [
  { id: 'taxi', icon: '🚕', label: 'Taxi', hint: 'A demanda' },
  { id: 'ruta', icon: '🛣️', label: 'Taxi Ruta', hint: 'Por persona' },
  { id: 'van', icon: '🚐', label: 'Furgoneta', hint: 'Rutas' },
  { id: 'tow', icon: '🛻', label: 'Grúa', hint: 'Tú ofertas' },
  { id: 'rental', icon: '🔑', label: 'Alquiler', hint: 'Tú ofertas' },
  { id: 'ellxs', icon: '🌈', label: 'Ellxs', hint: 'Mujeres y LGBTI' },
] as const;

const PREFS: { key: keyof TripPrefs; label: string }[] = [
  { key: 'quiet', label: '🤫 Silencio' },
  { key: 'ac', label: '❄ A/C' },
  { key: 'luggage', label: '🧳 Equipaje' },
  { key: 'pet', label: '🐾 Mascota' },
  { key: 'wheelchair', label: '♿ Accesible' },
];

/** Inicio: selector Viajar | Trabajar, mapa, saludo y servicios. */
function Services() {
  const session = useSession();
  const { api } = session;
  const nav = useNav();
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<{ defaultPrefs: TripPrefs; deviationAlerts: string; ellxsMember: boolean; chosenName: string | null } | null>(null);

  useEffect(() => {
    void currentLocation().then((f) => f && setHere(f)).catch(() => {});
    void api.loyalty().then((l) => setPoints(l.points)).catch(() => {});
    void api.preferences().then(setPrefs).catch(() => {});
  }, []);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const togglePref = async (k: keyof TripPrefs) => {
    if (!prefs) return;
    const defaultPrefs = { ...prefs.defaultPrefs, [k]: !prefs.defaultPrefs[k] };
    setPrefs({ ...prefs, defaultPrefs });
    await api.setPreferences({ defaultPrefs }).catch(() => {});
  };
  const open = (id: (typeof SERVICES)[number]['id']) => {
    if (id === 'taxi') nav.push('request');
    else if (id === 'ellxs') nav.push(prefs?.ellxsMember ? 'request' : 'preferences', prefs?.ellxsMember ? { ellxsOnly: true } : { hint: 'ellxs' });
    else if (id === 'ruta' || id === 'van') nav.push('routes', { vehicleType: id === 'van' ? 'van' : undefined });
    else nav.push(id);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 12 }}>
        <Text style={{ color: C.brand, fontSize: 13, letterSpacing: 4, fontWeight: '700' }}>☀ INTI TAXI</Text>
        <Segmented
          value="ride"
          onChange={(v) => v === 'work' && void session.mode.set('work').then(() => nav.reset('work'))}
          options={[
            { value: 'ride', label: 'Viajar' },
            { value: 'work', label: 'Trabajar' },
          ]}
        />
      </View>
      <TripMap height={220} markers={here ? [{ id: 'me', title: 'Estás aquí', ...here }] : []} />
      <View style={{ flex: 1, marginTop: -24, backgroundColor: C.card, borderTopLeftRadius: 26, borderTopRightRadius: 26, borderTopWidth: 1, borderColor: C.line, padding: 18, gap: 14 }}>
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 4, backgroundColor: C.line }} />
        <View>
          <P muted>
            {greeting}
            {prefs?.chosenName ? `, ${prefs.chosenName}` : ''}
          </P>
          <H>¿A dónde vamos?</H>
        </View>
        <Pressable accessibilityRole="search" onPress={() => nav.push('request')} style={{ backgroundColor: C.card2, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 14 }}>
          <Text style={{ color: C.muted, fontSize: 15 }}>⌕  Buscar destino</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {SERVICES.map((sv) => (
            <Pressable key={sv.id} accessibilityRole="button" onPress={() => open(sv.id)} style={({ pressed }) => ({ width: '31.5%', backgroundColor: C.card2, borderWidth: 1, borderColor: pressed ? C.brand : C.line, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 6, alignItems: 'center', gap: 3, overflow: 'hidden' })}>
              {sv.id === 'ellxs' ? (
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
                  <PrideBar height={3} />
                </View>
              ) : null}
              <Text style={{ fontSize: 24 }}>{sv.icon}</Text>
              <Text style={{ color: C.ink, fontSize: 13, fontWeight: '600' }}>{sv.label}</Text>
              <Text style={{ color: C.muted, fontSize: 10 }}>{sv.hint}</Text>
            </Pressable>
          ))}
        </View>
        {prefs ? (
          <Choice<string>
            value=""
            onChange={(k) => void togglePref(k as keyof TripPrefs)}
            options={PREFS.map((p) => ({ value: p.key, label: `${p.label}${prefs.defaultPrefs[p.key] ? ' ✓' : ''}` }))}
          />
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable onPress={() => nav.push('points')}>
            <Text style={{ color: C.brand2, fontFamily: SERIF }}>✦ {points ?? '—'} Inti Puntos</Text>
          </Pressable>
          <Pressable onPress={() => nav.push('preferences')}>
            <P muted>Alerta de desvío: {prefs?.deviationAlerts === 'always' ? 'siempre' : prefs?.deviationAlerts === 'off' ? 'apagada' : 'de noche'}</P>
          </Pressable>
        </Row>
      </View>
    </SafeAreaView>
  );
}

export function PrefsSummary({ prefs }: { prefs: TripPrefs }) {
  const on = PREFS.filter((p) => prefs[p.key]).map((p) => p.label);
  return on.length ? <P muted>{on.join(' · ')}</P> : null;
}

