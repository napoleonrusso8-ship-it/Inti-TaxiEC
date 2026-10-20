import * as Location from 'expo-location';
import type { LatLng } from '@intitaxi/mobile-core';

export interface Fix extends LatLng {
  /** Android marca las ubicaciones de apps de "ubicación simulada". */
  mocked: boolean;
}

/** Ubicación actual, solo en primer plano (la app de pasajero no pide ubicación en segundo plano). */
export async function currentLocation(): Promise<Fix | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return null;
  const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: p.coords.latitude, lng: p.coords.longitude, mocked: p.mocked === true };
}
