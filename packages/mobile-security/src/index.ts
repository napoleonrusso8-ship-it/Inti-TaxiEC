import { requireOptionalNativeModule } from 'expo-modules-core';

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface DeviceKey extends PublicJwk {
  /** Dónde vive la clave privada: chip seguro dedicado, entorno de ejecución confiable o software. */
  hardware: 'strongbox' | 'tee' | 'software';
}

export interface EnvironmentSignals {
  debuggable: boolean;
  debuggerAttached: boolean;
  adbEnabled: boolean;
  emulator: boolean;
  suBinary: boolean;
  hookingFramework: boolean;
  sdkInt: number;
}

interface NativeSecurity {
  ensureKey(alias: string): Promise<DeviceKey>;
  sign(alias: string, dataB64u: string): Promise<string>;
  deleteKey(alias: string): Promise<void>;
  integrityToken(nonce: string, cloudProjectNumber: number | null): Promise<string>;
  createPasskey(requestJson: string): Promise<string>;
  getPasskey(requestJson: string): Promise<string>;
  setSecureScreen(enabled: boolean): Promise<void>;
  environment(): EnvironmentSignals;
}

const native = requireOptionalNativeModule<NativeSecurity>('IntitaxiSecurity');

/** El módulo solo existe en una build nativa (EAS / Android Studio), no en Expo Go. */
export const isAvailable = native !== null;

function mod(): NativeSecurity {
  if (!native) throw new Error('El módulo de seguridad nativo no está disponible: instala una build de desarrollo de Inti Taxi (no Expo Go).');
  return native;
}

export const Security = {
  ensureKey: (alias: string) => mod().ensureKey(alias),
  sign: (alias: string, dataB64u: string) => mod().sign(alias, dataB64u),
  deleteKey: (alias: string) => mod().deleteKey(alias),
  integrityToken: (nonce: string, cloudProjectNumber?: number) => mod().integrityToken(nonce, cloudProjectNumber ?? null),
  createPasskey: async (options: unknown) => JSON.parse(await mod().createPasskey(JSON.stringify(options))) as Record<string, unknown>,
  getPasskey: async (options: unknown) => JSON.parse(await mod().getPasskey(JSON.stringify(options))) as Record<string, unknown>,
  setSecureScreen: (enabled: boolean) => (native ? native.setSecureScreen(enabled) : Promise.resolve()),
  environment: (): EnvironmentSignals | null => native?.environment() ?? null,
};

/** Señales que justifican limitar la app (p. ej. solo efectivo) antes de consultar al servidor. */
export function riskSignals(env: EnvironmentSignals | null): string[] {
  if (!env) return [];
  return Object.entries({ debugger: env.debuggerAttached, root: env.suBinary, hooking: env.hookingFramework, emulator: env.emulator })
    .filter(([, v]) => v)
    .map(([k]) => k);
}
