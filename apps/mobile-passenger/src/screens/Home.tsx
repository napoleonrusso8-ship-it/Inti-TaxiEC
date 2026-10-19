import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { C, Screen } from '../ui/kit';
import { Account } from './Account';
import { RequestTrip } from './RequestTrip';
import { Routes } from './Routes';

type Tab = 'viaje' | 'ruta' | 'cuenta';
const TABS: { id: Tab; label: string; title: string }[] = [
  { id: 'viaje', label: 'Taxi', title: '¿A dónde vamos?' },
  { id: 'ruta', label: 'Taxi Ruta', title: 'Taxi Ruta' },
  { id: 'cuenta', label: 'Cuenta', title: 'Mi cuenta' },
];

export function Home() {
  const { api } = useSession();
  const nav = useNav();
  const [tab, setTab] = useState<Tab>('viaje');

  // Si hay un viaje en curso (p. ej. la app se cerró), se retoma.
  useEffect(() => {
    void api.history().then((rows) => {
      const active = rows.find((t) => ['matching', 'accepted', 'arrived', 'in_progress'].includes(t.status));
      if (active) nav.push('trip', { tripId: active.id });
    }).catch(() => {});
  }, []);

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1 }}>
        <Screen title={current.title}>
          {tab === 'viaje' ? <RequestTrip /> : tab === 'ruta' ? <Routes /> : <Account />}
        </Screen>
      </View>
      <SafeAreaView edges={['bottom']} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card }}>
        {TABS.map((t) => (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: t.id === tab }} onPress={() => setTab(t.id)} style={{ flex: 1, paddingVertical: 14, alignItems: 'center' }}>
            <Text style={{ color: t.id === tab ? C.accent : C.muted, fontWeight: t.id === tab ? '700' : '500' }}>{t.label}</Text>
          </Pressable>
        ))}
      </SafeAreaView>
    </View>
  );
}
