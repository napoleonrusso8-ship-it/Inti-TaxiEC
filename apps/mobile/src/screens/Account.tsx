import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { money } from '@intitaxi/mobile-core';
import { Security } from '@intitaxi/mobile-security';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, Card, ErrorText, Field, ListItem, P, useAction } from '../ui/kit';

const KYC_LABEL: Record<string, string> = {
  approved: 'Identidad verificada ✓',
  created: 'Verificación en curso',
  declined: 'Verificación rechazada',
  duplicate_review: 'En revisión manual',
  resubmission_requested: 'Debes repetir la verificación',
};

export function Account() {
  const { api, client, keyHardware, risk, logoutAll } = useSession();
  const nav = useNav();
  const [me, setMe] = useState<Awaited<ReturnType<typeof api.me>> | null>(null);
  const [kyc, setKyc] = useState<string | null>(null);
  const [wallet, setWallet] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = () =>
    run(async () => {
      setMe(await api.me());
      setKyc((await api.kycStatus()).verification?.status ?? null);
      setWallet((await api.wallet()).balanceCents);
    });
  useEffect(() => void load(), []);

  return (
    <>
      {me ? (
        <Card>
          <P style={{ fontWeight: '700' }}>{me.phone}</P>
          <P muted>{me.email ? `${me.email}${me.emailVerified ? ' ✓' : ' (sin verificar)'}` : 'Sin correo'}</P>
          {me.sensitiveOpsLockedUntil ? <P muted>Por seguridad, algunas acciones están bloqueadas hasta {new Date(me.sensitiveOpsLockedUntil).toLocaleString('es-EC')}. Confirma con tu passkey para desbloquearlas.</P> : null}
        </Card>
      ) : null}
      <Pressable onPress={() => nav.push('verify')}>
        <Card>
          <P style={{ fontWeight: '700' }}>Verificación de identidad</P>
          <P muted>{kyc ? (KYC_LABEL[kyc] ?? kyc) : 'Sin verificar: tócala para verificar con tu cédula y una selfie'}</P>
        </Card>
      </Pressable>
      <Pressable onPress={() => nav.push('safety')}>
        <Card>
          <P style={{ fontWeight: '700' }}>Seguridad del viaje</P>
          <P muted>PIN de seguridad y de emergencia, contactos de confianza</P>
        </Card>
      </Pressable>
      <Card style={{ paddingVertical: 6 }}>
        <ListItem icon="🤝" title="Trabajar con Inti Taxi" subtitle="Conductor, dueño de taxi o furgoneta, empresa de alquiler o grúa" onPress={() => nav.push('partner.join')} />
      </Card>
      <Pressable onPress={() => nav.push('preferences')}>
        <Card>
          <P style={{ fontWeight: '700' }}>Preferencias</P>
          <P muted>Cómo quieres que te llamen, Modo Ellxs, alerta de desvío, viaje silencioso</P>
        </Card>
      </Pressable>
      <Pressable onPress={() => nav.push('points')}>
        <Card>
          <P style={{ fontWeight: '700' }}>✦ Inti Puntos</P>
          <P muted>Gana puntos en cada viaje y canjéalos por crédito</P>
        </Card>
      </Pressable>
      <Pressable onPress={() => nav.push('reports')}>
        <Card>
          <P style={{ fontWeight: '700' }}>Mis reportes</P>
          <P muted>Estado de los reportes que enviaste</P>
        </Card>
      </Pressable>
      <Card>
        <P style={{ fontWeight: '700' }}>Billetera: {money(wallet)}</P>
        <P muted>Solo reembolsos y créditos promocionales (sin recargas).</P>
      </Card>
      {!me?.email ? (
        <Card>
          <Field label="Agrega tu correo (recibos y avisos de seguridad)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <Button label="Guardar correo" kind="secondary" disabled={!email.includes('@')} onPress={() => run(async () => (await api.setEmail(email.trim()), setInfo('Te enviamos un enlace de verificación'), await load()))} />
        </Card>
      ) : null}
      <Card>
        <P style={{ fontWeight: '700' }}>Passkey</P>
        <P muted>Entra sin SMS, con tu huella o rostro. Resiste el robo de SIM y el phishing.</P>
        <Button label="Crear passkey" kind="secondary" loading={busy} onPress={() => run(async () => (await client.registerPasskey((o) => Security.createPasskey(o)), setInfo('Passkey creada')))} />
      </Card>
      <Card>
        <P muted>
          Clave del dispositivo: {keyHardware === 'strongbox' ? 'chip seguro (StrongBox)' : keyHardware === 'tee' ? 'entorno seguro (TEE)' : 'software'}
          {risk.length ? ` · riesgos detectados: ${risk.join(', ')}` : ''}
        </P>
      </Card>
      {info ? <P>{info}</P> : null}
      <ErrorText error={error} />
      <Button label="Cerrar sesión" kind="secondary" onPress={() => run(async () => (await logoutAll(), nav.reset('login')))} />
    </>
  );
}
