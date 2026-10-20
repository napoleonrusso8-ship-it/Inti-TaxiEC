import { Text, View } from 'react-native';
import type { DriverCard } from '@intitaxi/mobile-core';
import { Badge, C, Card, P, Row, Stars, Tag } from '../ui/kit';

/** Perfil del conductor asignado: calificación, viajes, etiquetas, insignias y placa. */
export function DriverProfile({ driver, title }: { driver: DriverCard; title?: string }) {
  return (
    <Card>
      {title ? <P muted>{title}</P> : null}
      <Row>
        <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: '#3A3326', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: C.brand2, fontSize: 22, fontWeight: '700' }}>{driver.firstName.slice(0, 1)}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ flexWrap: 'wrap', gap: 6 }}>
            <Text style={{ color: C.ink, fontSize: 17, fontWeight: '600' }}>{driver.firstName}</Text>
            {driver.identityVerified ? <Badge>✓ Identidad verificada</Badge> : null}
          </Row>
          <Row style={{ gap: 6 }}>
            <Stars value={driver.rating} />
            <P muted>
              {driver.rating ?? 'Nuevo'} · {driver.tripsCount.toLocaleString('es-EC')} viajes{driver.activeSince ? ` · desde ${driver.activeSince}` : ''}
            </P>
          </Row>
          {driver.vehicle ? (
            <P muted>
              {driver.vehicle.make} {driver.vehicle.model} {driver.vehicle.color}
            </P>
          ) : null}
        </View>
        {driver.vehicle ? (
          <View style={{ backgroundColor: C.ink, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
            <Text style={{ color: '#111', fontWeight: '800', letterSpacing: 1 }}>{driver.vehicle.plate}</Text>
          </View>
        ) : null}
      </Row>
      {driver.tags.length || driver.badges.ally || driver.badges.ellxs ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {driver.tags.map((t) => (
            <Tag key={t.tag} label={t.label} count={t.count} />
          ))}
          {driver.badges.ally ? <Tag label="🌈 Aliado" /> : null}
          {driver.badges.ellxs ? <Tag label="🌈 Ellxs" /> : null}
        </View>
      ) : null}
      <P muted>Comprueba la placa antes de subir. Si no te convence, puedes pedir otra unidad.</P>
    </Card>
  );
}
