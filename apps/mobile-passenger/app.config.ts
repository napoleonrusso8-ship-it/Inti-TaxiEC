import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Configuración nativa de la app de pasajero. Valores por build (EAS o local) mediante variables
 * de entorno; ninguno es un secreto (la clave de Maps de Android se restringe por paquete + firma).
 *
 * INTI_PROFILE=development|preview|production
 * INTI_CLEARTEXT_HOSTS   hosts HTTP permitidos SOLO en desarrollo (p. ej. "localhost,192.168.1.20")
 * INTI_PIN_DOMAINS       dominios con certificate pinning en producción (p. ej. "intitaxi.ec")
 * INTI_CERT_PINS         SHA-256 base64 de las claves públicas (actual + respaldo), separados por coma
 * GOOGLE_MAPS_ANDROID_KEY clave de Maps SDK for Android (restringida)
 */
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = process.env.INTI_PROFILE ?? 'development';
  const cleartextHosts = profile === 'production' ? [] : list(process.env.INTI_CLEARTEXT_HOSTS ?? 'localhost,127.0.0.1,10.0.2.2');
  const pins = list(process.env.INTI_CERT_PINS);
  if (profile === 'production' && pins.length < 2) throw new Error('Producción requiere al menos 2 pins de certificado (actual + respaldo) en INTI_CERT_PINS');
  const mapsKey = process.env.GOOGLE_MAPS_ANDROID_KEY;

  return {
    ...config,
    name: profile === 'production' ? 'Inti Taxi' : `Inti Taxi (${profile})`,
    slug: 'inti-taxi-pasajero',
    scheme: 'intitaxi',
    version: '0.1.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    android: {
      package: 'ec.intitaxi.passenger',
      versionCode: 1,
      adaptiveIcon: {
        backgroundColor: '#F2A900',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      // Solo ubicación en primer plano: el pasajero no necesita ubicación en segundo plano.
      permissions: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'],
      blockedPermissions: [
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_PHONE_STATE',
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
      ...(mapsKey ? { config: { googleMaps: { apiKey: mapsKey } } } : {}),
    },
    plugins: [
      ['expo-build-properties', { android: { minSdkVersion: 28, enableProguardInReleaseBuilds: true, enableShrinkResourcesInReleaseBuilds: true } }],
      ['expo-location', { locationWhenInUsePermission: 'Inti Taxi usa tu ubicación para recogerte y para compartirla en una emergencia.', isAndroidBackgroundLocationEnabled: false }],
      ['expo-secure-store', { configureAndroidBackup: false }],
      ['./plugins/withNetworkSecurity', { cleartextHosts, pinDomains: list(process.env.INTI_PIN_DOMAINS), pins, pinExpiration: process.env.INTI_PIN_EXPIRATION ?? '2027-12-31' }],
      require('./plugins/withNetworkSecurity').withNoBackupRules,
    ],
    extra: { profile },
  };
};
