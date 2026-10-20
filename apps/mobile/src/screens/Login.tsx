import { useEffect, useState } from 'react';
import { Security } from '@intitaxi/mobile-security';
import { normalizeEcMobile } from '@intitaxi/domain';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Text, View } from 'react-native';
import { Button, C, Card, ErrorText, Field, P, Screen, SERIF, useAction } from '../ui/kit';

/** Registro / inicio de sesión con SMS. La pantalla del código bloquea capturas (FLAG_SECURE). */
export function Login() {
  const { client } = useSession();
  const nav = useNav();
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    Security.setSecureScreen(true);
    return () => void Security.setSecureScreen(false);
  }, []);

  const request = () => {
    if (!normalizeEcMobile(phone)) return setError('Escribe un celular ecuatoriano válido (09…)');
    void run(async () => setChallenge((await client.requestOtp(phone.trim())).challengeId));
  };
  const verify = () =>
    run(async () => {
      await client.verifyOtp(challenge!, code.trim());
      nav.reset('welcome');
    });
  const passkey = () =>
    run(async () => {
      await client.loginWithPasskey((o) => Security.getPasskey(o));
      nav.reset('welcome');
    });

  return (
    <Screen>
      <View style={{ paddingTop: 36, paddingBottom: 8, gap: 8 }}>
        <Text style={{ color: C.brand, fontSize: 13, letterSpacing: 4, fontWeight: '700' }}>☀ INTI TAXI</Text>
        <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 34, lineHeight: 40 }}>Guayaquil se mueve seguro.</Text>
        <P muted>Una sola app para viajar y para trabajar: taxi, Taxi Ruta, furgonetas, grúas y alquiler. Todas las personas que viajan quedan registradas.</P>
      </View>
      {!challenge ? (
        <Card>
          <Field label="Tu celular" placeholder="0991234567" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={13} autoComplete="tel" />
          <Button label="Enviarme un código por SMS" onPress={request} loading={busy} />
          <ErrorText error={error} />
        </Card>
      ) : (
        <Card>
          <P>Escribe el código de 6 dígitos que enviamos a {phone}.</P>
          <Field label="Código" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" />
          <Button label="Entrar" onPress={verify} loading={busy} disabled={code.length !== 6} />
          <Button label="Cambiar número" kind="secondary" onPress={() => (setChallenge(null), setCode(''))} />
          <ErrorText error={error} />
        </Card>
      )}
      <Card>
        <P muted>¿Ya creaste una passkey? Es más segura que el SMS (no se puede robar con un cambio de SIM).</P>
        <Button label="Entrar con passkey" kind="secondary" onPress={passkey} disabled={busy} />
      </Card>
      <P muted style={{ color: C.muted }}>Al continuar aceptas los términos y la política de privacidad de Inti Taxi.</P>
    </Screen>
  );
}
