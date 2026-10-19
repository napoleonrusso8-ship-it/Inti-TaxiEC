import type { ClientConfig } from '@intitaxi/mobile-core';

/**
 * Configuración de la build (variables EXPO_PUBLIC_*, se fijan al compilar; NO son secretos).
 * Expo solo las sustituye si se escriben literalmente (process.env.EXPO_PUBLIC_X), no con acceso dinámico.
 * En desarrollo con el teléfono por USB, `adb reverse` permite usar localhost (ver README).
 */
const or = (v: string | undefined, fallback: string) => (v && v.length ? v : fallback);

export const config: ClientConfig & { attestation: 'play' | 'dev'; playCloudProject?: number; mapsEnabled: boolean } = {
  services: {
    auth: or(process.env.EXPO_PUBLIC_AUTH_URL, 'http://localhost:3001'),
    api: or(process.env.EXPO_PUBLIC_API_URL, 'http://localhost:3002'),
    sos: or(process.env.EXPO_PUBLIC_SOS_URL, 'http://localhost:3003'),
    realtime: or(process.env.EXPO_PUBLIC_REALTIME_URL, 'http://localhost:3004'),
  },
  appId: 'ec.intitaxi.passenger',
  clientId: 'intitaxi-passenger',
  // "dev" solo funciona contra un servidor con ATTESTATION_MODE=dev; las builds de producción usan Play Integrity.
  attestation: or(process.env.EXPO_PUBLIC_ATTESTATION, __DEV__ ? 'dev' : 'play') === 'dev' ? 'dev' : 'play',
  playCloudProject: Number(or(process.env.EXPO_PUBLIC_PLAY_CLOUD_PROJECT, '0')) || undefined,
  mapsEnabled: process.env.EXPO_PUBLIC_MAPS_ENABLED === 'true',
};
