# Módulo 11 — App Android de pasajero

> Estado: **primera versión funcional** — 2026-10-19. Verificado aquí: tipos, 5 pruebas unitarias, generación del proyecto Android (`expo prebuild`), compilación del JavaScript a bytecode de Hermes y 7 pruebas de extremo a extremo que ejecutan el mismo código de cliente de la app contra los servidores reales. **No verificado aquí:** la compilación del APK y el código Kotlin. En este entorno está bloqueada la descarga del Android SDK, así que el APK se compila en EAS (la nube de Expo) o en Android Studio.

## 1. Qué incluye

| Parte | Ubicación |
|---|---|
| App (Expo SDK 57, React Native 0.86, TypeScript) | `apps/mobile-passenger` |
| Módulo nativo de seguridad (Kotlin) | `packages/mobile-security` |
| Lógica compartida con la futura app de conductor: atestación, sesión DPoP, API y tiempo real | `packages/mobile-core` |
| Pruebas del cliente contra los servidores reales | `e2e/tests/m11-mobile-core.e2e.test.ts` |
| Conexión de un teléfono por USB a los servidores locales | `pnpm android:usb` (`scripts/android-usb.mjs`) |

Pantallas:
- Inicio de sesión por SMS o con passkey.
- Pedir taxi: origen por GPS o lugar, destino, acompañantes, viaje para otra persona y forma de pago.
- Viaje en vivo: conductor y placa, PIN, compartir viaje, cancelar, **SOS**, calificación, recibo y reclamo.
- Alerta SOS: ubicación cada 10 s y cancelación con PIN (con PIN de coacción).
- **Taxi Ruta**: paradas, asientos, vehículos con asientos libres y ETA, reserva, PIN, tarifa estimada y luego final, y recibo.
- Cuenta: verificación de identidad (KYC) con consentimiento, correo, passkey, PIN de seguridad, contactos de confianza, billetera e historial.

## 2. Seguridad en el teléfono

| Control | Cómo |
|---|---|
| **Clave del dispositivo en hardware** | Par P-256 creado dentro de Android Keystore (StrongBox si el teléfono lo tiene, si no TEE). La clave privada nunca sale del chip: JavaScript solo pide firmas. Con ella se firman las pruebas DPoP de cada petición |
| **Tokens ligados al teléfono** | El refresh token se guarda cifrado con `expo-secure-store` y solo funciona con la clave de ese teléfono: copiarlo a otro no sirve (probado). El token de acceso (10 min) vive solo en memoria |
| **Integridad de la app** | Play Integrity con nonce del servidor (el veredicto lo evalúa el servidor). Si el dispositivo solo tiene integridad básica (p. ej. rooteado), solo se permite el pago en efectivo |
| **Señales locales** | Depurador, binario `su`, Frida/Xposed en memoria, emulador. Son informativas: decide el servidor |
| **Capturas de pantalla** | `FLAG_SECURE` en las pantallas de código SMS, PIN, SOS y seguridad |
| **Red** | Nada de HTTP en claro (solo `localhost` en desarrollo); en producción, **certificate pinning** con dos pins obligatorios (actual y de respaldo), o la build no se genera |
| **Copias de seguridad** | `allowBackup=false` y reglas de extracción de datos: tokens y claves no se copian a la nube ni a otro teléfono |
| **Permisos mínimos** | Solo ubicación en primer plano. Se bloquean explícitamente ubicación en segundo plano, micrófono, estado del teléfono, superposición y almacenamiento |
| **Ubicación simulada** | Se detecta (`mocked`) y se avisa al pasajero |
| **Release** | R8/ProGuard y reducción de recursos activados |

## 3. Cómo probarla en tu teléfono Android

### Opción A — Compilar en la nube con EAS (no necesitas Android Studio para compilar)
1. Crea una cuenta gratuita en https://expo.dev.
2. En tu computadora (Node 22 y pnpm), dentro del repositorio:
   ```bash
   pnpm install
   cd apps/mobile-passenger
   npx eas-cli login
   npx eas-cli build --platform android --profile development
   ```
   Al terminar, EAS te da un enlace y un código QR para descargar el **APK**. Ábrelo en el teléfono e instálalo (permite "instalar apps de origen desconocido").
3. Conecta el teléfono a los servidores locales:
   - Instala **Android SDK Platform-Tools** (incluido en Android Studio) para tener `adb`.
   - En el teléfono activa **Opciones de desarrollador → Depuración USB** y conéctalo por cable.
   - En la computadora:
     ```bash
     pnpm dev            # servidores (terminal 1)
     pnpm android:usb    # conecta el teléfono a localhost (terminal 2)
     pnpm --filter @intitaxi/mobile-passenger start   # código de la app (terminal 2)
     ```
   - Abre la app "Inti Taxi (development)" en el teléfono. Se conecta sola al código de la computadora.
4. Inicia sesión con tu número. En desarrollo, el SMS no se envía de verdad: el código aparece en la **Bandeja** del simulador (http://localhost:4000).

### Opción B — Con Android Studio
Con el teléfono conectado y `pnpm dev` corriendo: `pnpm android:usb` y luego, dentro de `apps/mobile-passenger`, `npx expo run:android`. Compila e instala la app directamente.

### Por qué USB y no Wi-Fi
Cada petición va firmada para una URL exacta (DPoP), y en desarrollo los servidores se anuncian como `localhost`. `adb reverse` hace que `localhost` en el teléfono sea tu computadora, sin abrir los servidores a la red Wi-Fi. Para usarla sin cable hay que publicar los servidores con HTTPS: es el siguiente paso de infraestructura.

## 4. Para usarla de verdad (fuera de tu computadora)
1. **Servidores en la nube** con dominio y HTTPS (p. ej. `api.intitaxi.ec`), con `ATTESTATION_MODE=enforce`.
2. **Play Integrity**: vincular la app en Google Play Console con un proyecto de Google Cloud y darle al servidor las credenciales (`PLAY_INTEGRITY_CREDENTIALS_FILE`). Compilar con `EXPO_PUBLIC_PLAY_CLOUD_PROJECT`.
3. **Passkeys en Android**: publicar `https://<dominio>/.well-known/assetlinks.json` con el paquete `ec.intitaxi.passenger` y la huella SHA-256 del certificado de firma. Añadir `android:apk-key-hash:<hash>` a `WEBAUTHN_ORIGINS` y usar el dominio como `WEBAUTHN_RP_ID`. Con `localhost` las passkeys no funcionan en Android: en desarrollo se entra por SMS.
4. **Google Maps**: clave de Maps SDK for Android restringida al paquete y a la huella de firma (`GOOGLE_MAPS_ANDROID_KEY`, `EXPO_PUBLIC_MAPS_ENABLED=true`).
5. **Pins de certificado** (`INTI_PIN_DOMAINS`, `INTI_CERT_PINS` con dos pins y `INTI_PIN_EXPIRATION`) y build `production` (`.aab`) para Google Play.

## 5. Riesgos de seguridad y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Robo de tokens (malware, copia de seguridad, otro teléfono) | Clave DPoP no exportable en Keystore; refresh token ligado a esa clave; sin copias de seguridad; token de acceso de 10 min solo en memoria |
| App modificada, emulador o root automatizando pedidos | Play Integrity evaluado en el servidor (ticket de 10 min, renovación automática); integridad básica → solo efectivo; señales locales como apoyo |
| Intercepción TLS (proxy con certificado instalado) | Solo CAs del sistema (no las del usuario), certificate pinning en producción, nada en claro |
| Fuga por capturas o grabación de pantalla | `FLAG_SECURE` en código, PIN, SOS y seguridad |
| SOS accidental | Botón de mantener presionado (1,2 s). Al activarse abre el marcador con el 911 y avisa al centro de monitoreo aunque la red falle después |
| Coacción para cancelar el SOS | El PIN de coacción muestra "cancelada" y la alerta sigue (lo decide el servidor) |
| GPS falso | Aviso al pasajero; para el conductor el servidor ya rechaza saltos imposibles |
| Configuración insegura publicada por error | La build `production` falla sin pins; el modo de atestación "dev" solo funciona contra servidores en modo desarrollo |
| Dependencias de terceros | Versiones exactas de hace más de 2 semanas; sin librerías extra de navegación ni de passkeys (Credential Manager directo en Kotlin) |

Riesgos residuales:
- El Kotlin no se compiló en este entorno: puede requerir ajustes menores en la primera compilación en EAS o Android Studio.
- No hay RASP comercial: la decisión D12 prevé DexGuard o similar antes del lanzamiento público.
- La ETA de Taxi Ruta es aproximada.

## 6. Pendiente
- **App de conductor** (siguiente). Reutiliza `mobile-core` y `mobile-security`, y añade ubicación en segundo plano mientras trabaja, ofertas, navegación, re-verificación con selfie, documentos, ganancias y Taxi Ruta del conductor.
- Pago con tarjeta desde la app (SDK de tokenización de Kushki con 3-D Secure), notificaciones push (FCM), chat en la pantalla del viaje, audio del SOS, búsqueda de direcciones (Google Places) e iOS.

## 7. Revisión legal y de publicación
- Formulario de **Seguridad de los datos** de Google Play y **política de privacidad** pública (LOPDP): ubicación, identidad, biometría (procesada por el proveedor KYC) y datos de acompañantes.
- Justificación de permisos de ubicación ante Google Play.
- Textos de consentimiento mostrados en la app (los sirve el servidor, versionados): revisión del abogado y del DPO.
