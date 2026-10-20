import type { SecureStore as SecureStoreLike } from '@intitaxi/auth-client';
import { ApiClient, hardwareSigner, partnerApi, passengerApi, RealtimeClient } from '@intitaxi/mobile-core';
import { isAvailable, riskSignals, Security } from '@intitaxi/mobile-security';
import * as SecureStore from 'expo-secure-store';
import { config } from './config';

/** Refresh tokens en el Keystore (expo-secure-store cifra con una clave de hardware). Nunca en AsyncStorage. */
const secure = (prefix: string): SecureStoreLike => ({
  get: (k) => SecureStore.getItemAsync(prefix + k),
  set: (k, v) => SecureStore.setItemAsync(prefix + k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  delete: (k) => SecureStore.deleteItemAsync(prefix + k),
});

export type Mode = 'ride' | 'work';

export interface PartnerSession {
  client: ApiClient;
  api: ReturnType<typeof partnerApi>;
  realtime: RealtimeClient;
  /** Abre la sesión de socio a partir de la de pasajero (sin otro SMS). */
  ensure(): Promise<void>;
}

export interface AppSession {
  client: ApiClient;
  api: ReturnType<typeof passengerApi>;
  realtime: RealtimeClient;
  partner: PartnerSession;
  keyHardware: string;
  risk: string[];
  mode: { get(): Promise<Mode>; set(m: Mode): Promise<void> };
  logoutAll(): Promise<void>;
}

/**
 * Crea la clave del dispositivo (Keystore), atestigua la app y recupera las sesiones.
 * Una sola app, dos sesiones con la MISMA clave de hardware: la de pasajero (intitaxi-passenger) y la de
 * socio (intitaxi-driver). Así el servidor mantiene separados los permisos de cada rol.
 */
export async function startSession(): Promise<AppSession> {
  if (!isAvailable) throw new Error('Esta versión no incluye el módulo de seguridad. Instala la build de desarrollo de Inti Taxi (no Expo Go).');
  const signer = await hardwareSigner(Security);
  const attestor = async (nonce: string) =>
    config.attestation === 'dev' ? `dev-ok:${nonce}` : Security.integrityToken(nonce, config.playCloudProject);
  const client = new ApiClient({ ...config, clientId: 'intitaxi-passenger' }, signer, secure(''), attestor);
  const partnerClient = new ApiClient({ ...config, clientId: 'intitaxi-driver' }, signer, secure('partner.'), attestor);
  await client.attest();
  await client.restore();
  if (client.loggedIn) await partnerClient.restore().catch(() => false);
  const prefs = secure('ui.');
  const partner: PartnerSession = {
    client: partnerClient,
    api: partnerApi(partnerClient),
    realtime: new RealtimeClient(partnerClient),
    ensure: async () => {
      if (!partnerClient.loggedIn) await partnerClient.linkFrom(client);
    },
  };
  return {
    client,
    api: passengerApi(client),
    realtime: new RealtimeClient(client),
    partner,
    keyHardware: signer.hardware,
    risk: riskSignals(Security.environment()),
    mode: {
      get: async () => ((await prefs.get('mode')) === 'work' ? 'work' : 'ride'),
      set: (m) => prefs.set('mode', m),
    },
    logoutAll: async () => {
      if (partnerClient.loggedIn) await partnerClient.logout();
      await client.logout();
      await prefs.delete('mode');
    },
  };
}
