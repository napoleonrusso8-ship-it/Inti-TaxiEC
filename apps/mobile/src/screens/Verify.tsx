import { useEffect, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useSession } from '../lib/session-context';
import { Button, Card, ErrorText, H, Loading, P, Screen, useAction } from '../ui/kit';

/**
 * Verificación de identidad con el proveedor KYC (documento + selfie con prueba de vida).
 * Primero el consentimiento EXPLÍCITO y separado para datos biométricos (LOPDP art. 26).
 * La selfie la toma el SDK/web del proveedor: la app de Inti Taxi no guarda imágenes del rostro.
 */
export function Verify() {
  const { api } = useSession();
  const [text, setText] = useState<{ title: string; body: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const refresh = () => run(async () => setStatus((await api.kycStatus()).verification?.status ?? null));
  useEffect(() => {
    void run(async () => setText(await api.consentText('biometric_kyc')));
    void refresh();
  }, []);
  if (!text) return <Screen title="Verificar identidad">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  return (
    <Screen title="Verificar identidad">
      {status === 'approved' ? <H>Tu identidad está verificada ✓</H> : null}
      <Card>
        <P style={{ fontWeight: '700' }}>{text.title}</P>
        <P>{text.body}</P>
      </Card>
      {status !== 'approved' ? (
        <Button
          label="Acepto y quiero verificarme"
          kind="brand"
          loading={busy}
          onPress={() =>
            run(async () => {
              await api.grantConsent('biometric_kyc');
              const s = await api.startKyc();
              await WebBrowser.openBrowserAsync(s.sessionUrl);
              await refresh();
            })
          }
        />
      ) : null}
      {status && status !== 'approved' ? <P muted>Estado: {status}. Si ya terminaste, actualiza.</P> : null}
      <Button label="Actualizar estado" kind="secondary" onPress={refresh} />
      <P muted>Puedes retirar este consentimiento cuando quieras desde la configuración de privacidad.</P>
      <ErrorText error={error} />
    </Screen>
  );
}
