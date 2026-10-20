import { useEffect, useState } from 'react';
import { Alert, Switch } from 'react-native';
import type { TripPrefs } from '@intitaxi/mobile-core';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, Loading, P, PrideBar, Row, Screen, useAction } from '../ui/kit';

type Prefs = Awaited<ReturnType<ReturnType<typeof useSession>['api']['preferences']>>;
const PREFS: { key: keyof TripPrefs; label: string }[] = [
  { key: 'quiet', label: '🤫 Viaje silencioso' },
  { key: 'ac', label: '❄ Aire acondicionado' },
  { key: 'luggage', label: '🧳 Llevo equipaje' },
  { key: 'pet', label: '🐾 Viajo con mascota' },
  { key: 'wheelchair', label: '♿ Necesito vehículo accesible' },
];

/** Cómo quieres que te llamen, Modo Ellxs, alerta de desvío y preferencias por defecto. */
export function Preferences({ hint }: { hint?: 'ellxs' }) {
  const { api } = useSession();
  const [p, setP] = useState<Prefs | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => void run(async () => {
    const r = await api.preferences();
    setP(r);
    setName(r.chosenName ?? '');
  }), []);
  if (!p) return <Screen title="Preferencias">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;

  const save = (patch: Partial<Prefs>) =>
    run(async () => {
      await api.setPreferences(patch);
      setP({ ...p, ...patch });
      setSaved(true);
    });

  /**
   * Modo Ellxs es un dato SENSIBLE (LOPDP art. 26): se activa solo con consentimiento explícito y separado,
   * mostrando el texto legal vigente. Desactivarlo borra la autodeclaración.
   */
  const toggleEllxs = (on: boolean) => {
    if (!on) return void save({ ellxsMember: false });
    void run(async () => {
      const t = await api.consentText('ellxs');
      Alert.alert(t.title, t.body, [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Acepto', onPress: () => void run(async () => (await api.grantConsent('ellxs'), await api.setPreferences({ ellxsMember: true }), setP({ ...p, ellxsMember: true }), setSaved(true))) },
      ]);
    });
  };

  return (
    <Screen title="Preferencias">
      {hint === 'ellxs' && !p.ellxsMember ? (
        <Card style={{ borderColor: C.brand }}>
          <P>🌈 Modo Ellxs te conecta solo con conductorxs Ellxs verificadxs. Para usarlo, actívalo abajo.</P>
        </Card>
      ) : null}
      <Card>
        <P style={{ fontWeight: '700' }}>¿Cómo quieres que te llamen?</P>
        <P muted>El conductor verá este nombre en lugar del de tu cédula. Tu identidad verificada no cambia.</P>
        <Field label="Nombre a mostrar" value={name} onChangeText={setName} maxLength={40} autoCapitalize="words" />
        <Button label="Guardar nombre" kind="secondary" loading={busy} onPress={() => save({ chosenName: name.trim() || null })} />
      </Card>
      <Card>
        <PrideBar />
        <P style={{ fontWeight: '700' }}>🌈 Modo Ellxs</P>
        <P muted>
          Para mujeres y personas de la comunidad LGBTI. Lo declaras tú: no pedimos pruebas ni preguntamos a qué grupo perteneces. Solo sirve para habilitar viajes con conductorxs Ellxs, nunca se muestra al conductor y puedes desactivarlo cuando quieras.
        </P>
        <Row>
          <Switch value={p.ellxsMember} onValueChange={toggleEllxs} thumbColor={p.ellxsMember ? C.brand : undefined} />
          <P style={{ flex: 1 }}>Soy mujer o parte de la comunidad LGBTI</P>
        </Row>
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Alerta de desvío</P>
        <P muted>Si el vehículo se aleja de tu destino o se detiene mucho tiempo, te preguntamos si estás bien. Si no respondes a tiempo, activamos la ayuda.</P>
        <Choice<Prefs['deviationAlerts']>
          value={p.deviationAlerts}
          onChange={(v) => void save({ deviationAlerts: v })}
          options={[
            { value: 'night', label: 'De noche (21:00–06:00)' },
            { value: 'always', label: 'Siempre' },
            { value: 'off', label: 'Apagada' },
          ]}
        />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Preferencias de viaje por defecto</P>
        {PREFS.map((x) => (
          <Row key={x.key}>
            <Switch value={!!p.defaultPrefs[x.key]} onValueChange={(v) => void save({ defaultPrefs: { ...p.defaultPrefs, [x.key]: v } })} thumbColor={p.defaultPrefs[x.key] ? C.brand : undefined} />
            <P>{x.label}</P>
          </Row>
        ))}
      </Card>
      {saved ? <P muted>Cambios guardados ✓</P> : null}
      <ErrorText error={error} />
    </Screen>
  );
}
