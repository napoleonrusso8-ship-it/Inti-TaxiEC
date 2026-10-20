import { View } from 'react-native';
import type { LatLng } from '@intitaxi/mobile-core';
import { config } from '../lib/config';
import { C, P } from '../ui/kit';

/** Estilo de mapa oscuro (acorde a la paleta negro/dorado). */
const DARK_MAP = [
  { elementType: 'geometry', stylers: [{ color: '#15161a' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a877f' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0b0d' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2c33' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a24' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
];

export interface Marker extends LatLng {
  id: string;
  title: string;
  color?: string;
}

/**
 * Mapa con Google Maps (react-native-maps). Requiere la clave de Android en la build
 * (GOOGLE_MAPS_ANDROID_KEY). Sin clave se muestra un resumen de coordenadas.
 */
export function TripMap({ markers, path, height = 220 }: { markers: Marker[]; path?: LatLng[]; height?: number }) {
  if (!config.mapsEnabled) {
    return (
      <View style={{ height: 90, borderRadius: 16, backgroundColor: C.card2, borderWidth: 1, borderColor: C.line, padding: 12, justifyContent: 'center' }}>
        <P muted>Mapa no configurado en esta build.</P>
        {markers.map((m) => (
          <P key={m.id} muted>
            {m.title}: {m.lat.toFixed(4)}, {m.lng.toFixed(4)}
          </P>
        ))}
      </View>
    );
  }
  // Carga diferida: el módulo nativo de mapas solo se necesita si hay clave.
  const Maps = require('react-native-maps') as typeof import('react-native-maps');
  const MapView = Maps.default;
  const first = markers[0] ?? { lat: -2.17, lng: -79.9 };
  return (
    <MapView
      style={{ height, borderRadius: 12 }}
      provider={Maps.PROVIDER_GOOGLE}
      initialRegion={{ latitude: first.lat, longitude: first.lng, latitudeDelta: 0.06, longitudeDelta: 0.06 }}
      customMapStyle={DARK_MAP}
      toolbarEnabled={false}
    >
      {path && path.length > 1 ? <Maps.Polyline coordinates={path.map((p) => ({ latitude: p.lat, longitude: p.lng }))} strokeColor={C.accent} strokeWidth={4} /> : null}
      {markers.map((m) => (
        <Maps.Marker key={m.id} coordinate={{ latitude: m.lat, longitude: m.lng }} title={m.title} pinColor={m.color} />
      ))}
    </MapView>
  );
}
