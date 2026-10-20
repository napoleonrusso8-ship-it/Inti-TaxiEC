import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { TripPrefs } from '@intitaxi/mobile-core';
import { TripMap } from '../components/Map';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { C, Choice, H, P, Row, Screen, SERIF } from '../ui/kit';
import { Account } from './Account';
import { HistoryList } from './History';

type Tab = 'inicio' | 'viajes' | 'cuenta';
const TABS: { id: Tab; label: string; title?: string }[] = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'viajes', label: 'Mis viajes', title: 'Mis viajes' },
  { id: 'cuenta', label: 'Cuenta', title: 'Mi cuenta' },
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
      <SafeAreaView edges={['bottom']} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.bg }}>
        {TABS.map((t) => (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: t.id === tab }} onPress={() => setTab(t.id)} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
            <Text style={{ color: t.id === tab ? C.brand : C.muted, fontWeight: t.id === tab ? '700' : '500' }}>{t.label}</Text>
          </Pressable>
        ))}
      </SafeAreaView>
    </View>
  );
}

const SERVICES = [
  { id: 'taxi', icon: '🚕', label: 'Taxi' },
  { id: 'ruta', icon: '🛣️', label: 'Taxi Ruta' },
  { id: 'van', icon: '🚐', label: 'Furgoneta' },
  { id: 'tow', icon: '🛻', label: 'Grúa' },
  { id: 'rental', icon: '🔑', label: 'Alquiler' },
  { id: 'ella', icon: '✦', label: 'Modo Ella' },
] as const;

const PREFS: { key: keyof TripPrefs; label: string }[] = [
  { key: 'quiet', label: '🤫 Silencio' },
  { key: 'ac', label: '❄ A/C' },
  { key: 'luggage', label: '🧳 Equipaje' },
  { key: 'pet', label: '🐾 Mascota' },
  { key: 'wheelchair', label: '♿ Accesible' },
];

/** Inicio: mapa, saludo y servicios (estilo de la propuesta aprobada: negro y dorado). */
function Services() {
  const { api } = useSession();
  const nav = useNav();
  const [here, setHere] = useState<{ lat: number; lng: number } | null>(null);
  const [points, setPoints] = useState<number | null>(null);
  const [prefs, setPrefs] = useState<{ defaultPrefs: TripPrefs; deviationAlerts: string; selfIdentifiesWoman: boolean; chosenName: string | null } | null>(null);

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
    else if (id === 'ella') nav.push(prefs?.selfIdentifiesWoman ? 'request' : 'preferences', prefs?.selfIdentifiesWoman ? { womenOnly: true } : { hint: 'ella' });
    else if (id === 'ruta' || id === 'van') nav.push('routes', { vehicleType: id === 'van' ? 'van' : undefined });
    else nav.push(id);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: C.bg }}>
      <TripMap height={260} markers={here ? [{ id: 'me', title: 'Estás aquí', ...here }] : []} />
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
            <Pressable key={sv.id} accessibilityRole="button" onPress={() => open(sv.id)} style={({ pressed }) => ({ width: '31.5%', backgroundColor: C.card2, borderWidth: 1, borderColor: pressed ? C.brand : C.line, borderRadius: 16, paddingVertical: 12, alignItems: 'center', gap: 4 })}>
              <Text style={{ fontSize: 22 }}>{sv.icon}</Text>
              <Text style={{ color: C.ink, fontSize: 12 }}>{sv.label}</Text>
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

