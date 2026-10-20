import { useEffect, useState } from 'react';
import { Switch } from 'react-native';
import type { TripPrefs } from '@intitaxi/mobile-core';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, Loading, P, Row, Screen, useAction } from '../ui/kit';

type Prefs = Awaited<ReturnType<ReturnType<typeof useSession>['api']['preferences']>>;
const PREFS: { key: keyof TripPrefs; label: string }[] = [
  { key: 'quiet', label: '🤫 Viaje silencioso' },
  { key: 'ac', label: '❄ Aire acondicionado' },
  { key: 'luggage', label: '🧳 Llevo equipaje' },
  { key: 'pet', label: '🐾 Viajo con mascota' },
  { key: 'wheelchair', label: '♿ Necesito vehículo accesible' },
];

/** Cómo quieres que te llamen, Modo Ella, alerta de desvío y preferencias por defecto. */
export function Preferences({ hint }: { hint?: 'ella' }) {
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

  return (
    <Screen title="Preferencias">
      {hint === 'ella' && !p.selfIdentifiesWoman ? (
        <Card style={{ borderColor: C.brand }}>
          <P>✦ Modo Ella te conecta solo con conductoras verificadas. Para usarlo, actívalo abajo.</P>
        </Card>
      ) : null}
      <Card>
        <P style={{ fontWeight: '700' }}>¿Cómo quieres que te llamen?</P>
        <P muted>El conductor verá este nombre en lugar del de tu cédula. Tu identidad verificada no cambia.</P>
        <Field label="Nombre a mostrar" value={name} onChangeText={setName} maxLength={40} autoCapitalize="words" />
        <Button label="Guardar nombre" kind="secondary" loading={busy} onPress={() => save({ chosenName: name.trim() || null })} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>✦ Modo Ella</P>
        <P muted>Para mujeres (incluidas mujeres trans). Lo declaras tú: no pedimos pruebas ni guardamos tu orientación o identidad. Solo sirve para habilitar viajes con conductoras.</P>
        <Row>
          <Switch value={p.selfIdentifiesWoman} onValueChange={(v) => void save({ selfIdentifiesWoman: v })} thumbColor={p.selfIdentifiesWoman ? C.brand : undefined} />
          <P>Me identifico como mujer</P>
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
