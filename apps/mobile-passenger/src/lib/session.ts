import { ApiClient, hardwareSigner, passengerApi, RealtimeClient } from '@intitaxi/mobile-core';
import { isAvailable, riskSignals, Security } from '@intitaxi/mobile-security';
import * as SecureStore from 'expo-secure-store';
import { config } from './config';

/** Refresh token en el Keystore (expo-secure-store cifra con una clave de hardware). Nunca en AsyncStorage. */
const store = {
  get: (k: string) => SecureStore.getItemAsync(k),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  delete: (k: string) => SecureStore.deleteItemAsync(k),
};

export interface AppSession {
  client: ApiClient;
  api: ReturnType<typeof passengerApi>;
  realtime: RealtimeClient;
  keyHardware: string;
  risk: string[];
}

/** Crea la clave del dispositivo (Keystore), atestigua la app y recupera la sesión si existe. */
export async function startSession(): Promise<AppSession> {
  if (!isAvailable) throw new Error('Esta versión no incluye el módulo de seguridad. Instala la build de desarrollo de Inti Taxi (no Expo Go).');
  const signer = await hardwareSigner(Security);
  const attestor = async (nonce: string) =>
    config.attestation === 'dev' ? `dev-ok:${nonce}` : Security.integrityToken(nonce, config.playCloudProject);
  const client = new ApiClient(config, signer, store, attestor);
  await client.attest();
  await client.restore();
  return { client, api: passengerApi(client), realtime: new RealtimeClient(client), keyHardware: signer.hardware, risk: riskSignals(Security.environment()) };
}
