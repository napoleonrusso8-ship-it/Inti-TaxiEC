import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { Security } from '@intitaxi/mobile-security';
import { currentLocation } from '../lib/location';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, ErrorText, Field, H, P, Screen, useAction } from '../ui/kit';

/**
 * Alerta activa: se envía la ubicación cada 10 s al servicio SOS (aislado del resto de la API).
 * Cancelar exige el PIN de seguridad; el PIN de coacción "cancela" en pantalla pero la alerta sigue.
 */
export function Sos({ incidentId }: { incidentId: string }) {
  const { api } = useSession();
  const nav = useNav();
  const [pin, setPin] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void Security.setSecureScreen(true);
    const t = setInterval(async () => {
      const loc = await currentLocation().catch(() => null);
      if (loc) await api.sosLocation(incidentId, { lat: loc.lat, lng: loc.lng }).catch(() => {});
    }, 10_000);
    return () => {
      clearInterval(t);
      void Security.setSecureScreen(false);
    };
  }, [incidentId]);

  if (cancelled) {
    return (
      <Screen title="Alerta">
        <H>Alerta cancelada</H>
        <Button label="Volver al viaje" onPress={nav.back} />
      </Screen>
    );
  }
  return (
    <Screen title="Alerta SOS">
      <Card style={{ backgroundColor: 'rgba(229,72,77,0.12)', borderColor: C.danger }}>
        <H>Alerta enviada</H>
        <P>El centro de monitoreo de Inti Taxi ya tiene tu ubicación y los datos del vehículo. Si no responden a tiempo, el caso se escala al ECU 911 con el registro de quienes viajan.</P>
        <P>Tus contactos de confianza recibieron un SMS con el enlace de seguimiento.</P>
      </Card>
      <Button label="Llamar al 911" kind="danger" onPress={() => void Linking.openURL('tel:911')} />
      <Card>
        <P style={{ fontWeight: '700' }}>¿Fue un error? Cancela con tu PIN de seguridad</P>
        <Field label="PIN de seguridad" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Button label="Cancelar alerta" kind="secondary" loading={busy} disabled={pin.length < 4} onPress={() => run(async () => (await api.sosCancel(incidentId, pin), setCancelled(true)))} />
        <ErrorText error={error} />
      </Card>
    </Screen>
  );
}
