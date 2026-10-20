import * as Location from 'expo-location';
import type { PartnerApi } from '@intitaxi/mobile-core';

/**
 * Ubicación del socio mientras está conectado (solo con la app abierta: no se pide ubicación en segundo plano).
 * Vive fuera de las pantallas para que siga enviándose al pasar de "ofertas" al viaje o a la ruta.
 */
let sub: Location.LocationSubscription | null = null;
let last: { lat: number; lng: number; mocked: boolean } | null = null;

export const workLocation = {
  get active() {
    return sub !== null;
  },
  get last() {
    return last;
  },
  /** Pide permiso y devuelve la posición actual (o null si no hay permiso). */
  async current() {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    last = { lat: p.coords.latitude, lng: p.coords.longitude, mocked: p.mocked === true };
    return last;
  },
  async start(api: PartnerApi) {
    if (sub) return;
    sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 15 }, (p) => {
      last = { lat: p.coords.latitude, lng: p.coords.longitude, mocked: p.mocked === true };
      // El servidor rechaza y registra ubicaciones simuladas.
      void api.location({ lat: last.lat, lng: last.lng }, last.mocked).catch(() => {});
    });
  },
  stop() {
    sub?.remove();
    sub = null;
  },
};
