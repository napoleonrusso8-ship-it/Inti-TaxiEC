import { useState } from 'react';
import { Text, View } from 'react-native';
import { ApiError, PARTNER_KINDS, type PartnerKind } from '@intitaxi/mobile-core';
import { useNav } from '../../lib/nav';
import { useSession } from '../../lib/session-context';
import { C, Card, ErrorText, IconCircle, P, Screen, SERIF, useAction } from '../../ui/kit';

/**
 * "¿Cómo quieres usar Inti Taxi?" — se muestra al registrarse y desde Cuenta → Trabajar con Inti Taxi.
 * Usuario normal o socio: conductor de taxi, dueño de taxi amarillo (Taxi Ruta), dueño de furgoneta,
 * empresa de alquiler de autos u operador de grúa.
 */
export function RoleMenu({ onlyPartners }: { onlyPartners?: boolean }) {
  const session = useSession();
  const nav = useNav();
  const [picking, setPicking] = useState<string | null>(null);
  const { error, run } = useAction();

  const ride = () =>
    run(async () => {
      await session.mode.set('ride');
      nav.reset('home');
    });

  const work = (kind: PartnerKind) =>
    run(async () => {
      setPicking(kind);
      try {
        await session.partner.ensure();
        // ¿Ya tiene una solicitud de socio? Entonces va directo a su panel.
        const existing = await session.partner.api.profile().catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
        await session.mode.set('work');
        if (existing) nav.reset('work');
        else nav.push('partner.apply', { kind });
      } finally {
        setPicking(null);
      }
    });

  return (
    <Screen title={onlyPartners ? 'Trabajar con Inti Taxi' : undefined}>
      {!onlyPartners ? (
        <View style={{ paddingTop: 28, gap: 6 }}>
          <Text style={{ color: C.brand, fontSize: 13, letterSpacing: 4, fontWeight: '700' }}>☀ INTI TAXI</Text>
          <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 30, lineHeight: 36 }}>¿Cómo quieres usar Inti Taxi?</Text>
          <P muted>Puedes cambiarlo cuando quieras desde tu cuenta. Una sola app para viajar y para trabajar.</P>
        </View>
      ) : (
        <P muted>Elige cómo quieres trabajar. Tu identidad verificada sirve para todo; para cada perfil pedimos solo los documentos necesarios.</P>
      )}
      {!onlyPartners ? (
        <Card onPress={ride} style={{ borderColor: C.brand }}>
          <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
            <IconCircle icon="🙋" size={48} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.ink, fontSize: 17, fontWeight: '700' }}>Quiero viajar</Text>
              <P muted>Taxi, Taxi Ruta, furgonetas, grúas y alquiler</P>
            </View>
          </View>
        </Card>
      ) : null}
      {!onlyPartners ? <Text style={{ color: C.muted, fontSize: 11, letterSpacing: 1.2, fontWeight: '600', marginTop: 6 }}>QUIERO TRABAJAR COMO…</Text> : null}
      {PARTNER_KINDS.map((k) => (
        <Card key={k.kind} onPress={() => void work(k.kind)}>
          <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
            <IconCircle icon={k.icon} size={48} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.ink, fontSize: 16, fontWeight: '700' }}>{k.title}</Text>
              <P muted>{picking === k.kind ? 'Abriendo tu perfil de socio…' : k.subtitle}</P>
            </View>
            <Text style={{ color: C.faint, fontSize: 22 }}>›</Text>
          </View>
        </Card>
      ))}
      <ErrorText error={error} />
    </Screen>
  );
}
