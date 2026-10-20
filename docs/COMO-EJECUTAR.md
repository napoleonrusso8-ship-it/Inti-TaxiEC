# Cómo hacer funcionar Inti Taxi

Guía paso a paso para probar todo en tu computadora y en tu teléfono Android. No necesitas datos ni claves reales: en desarrollo los SMS, la verificación de identidad, los pagos y el ECU 911 son simulados.

## 1. Lo que necesitas instalar (una sola vez)

| Programa | Para qué | Dónde |
|---|---|---|
| **Git** | Descargar el código | https://git-scm.com |
| **Node.js 22** | Ejecutar los servidores | https://nodejs.org (versión 22 LTS) |
| **pnpm 10** | Instalar dependencias | En una terminal: `npm install -g pnpm@10` |
| **Docker Desktop** | Base de datos (PostgreSQL) y Redis | https://www.docker.com/products/docker-desktop |
| **Android Studio** (o solo *Platform-Tools*) | Conectar el teléfono por cable (`adb`) y, si quieres, compilar la app | https://developer.android.com/studio |
| Cuenta gratuita de **Expo** | Compilar la app en la nube (opción A) | https://expo.dev |

En Windows usa la terminal **PowerShell** o **Git Bash**; en Mac/Linux la Terminal normal.

## 2. Descargar el código e instalar

```bash
git clone https://github.com/napoleonrusso8-ship-it/Inti-TaxiEC.git
cd Inti-TaxiEC
pnpm install
```

## 3. Arrancar los servidores, el simulador y el panel

Con Docker Desktop abierto:

```bash
pnpm dev
```

La primera vez tarda unos minutos: crea `.env.dev` con claves aleatorias **solo para tu computadora**, levanta PostgreSQL y Redis en Docker, aplica las migraciones, compila y arranca todo. Cuando termine verás:

- **Simulador**: http://localhost:4000 — pasajeros, conductores y administradores de prueba, y la **Bandeja** donde llegan los SMS y correos simulados (aquí ves el código de 6 dígitos para iniciar sesión).
- **Panel de administración**: http://localhost:4100 — revisar documentos, aprobar socios y rutas, reportes, etc.
- Servicios: auth `3001`, api `3002`, sos `3003`, tiempo real `3004`.

Para detener: `Ctrl + C`. Para volver a empezar con la base vacía: `docker compose down -v` y otra vez `pnpm dev`.

## 4. Instalar la app en tu teléfono Android

La app es **una sola** para viajar y para trabajar (paquete `ec.intitaxi.app`). Necesita la versión de desarrollo (no funciona en Expo Go porque trae un módulo nativo de seguridad).

### Opción A — Compilar en la nube con EAS (recomendada, no necesitas Android Studio para compilar)

```bash
cd apps/mobile
npx eas-cli login
npx eas-cli build --platform android --profile development
```

Al terminar, EAS te muestra un enlace y un **código QR**. Ábrelo en el teléfono, descarga el **APK** e instálalo (Android te pedirá permitir "instalar apps de origen desconocido").

### Opción B — Compilar en tu computadora con Android Studio

Con el teléfono conectado por USB (ver paso 5):

```bash
cd apps/mobile
npx expo run:android
```

## 5. Conectar el teléfono a tu computadora

1. En el teléfono: **Ajustes → Acerca del teléfono →** toca 7 veces **Número de compilación** para activar las opciones de desarrollador. Luego **Opciones de desarrollador → Depuración USB**: activada.
2. Conéctalo por cable y acepta el aviso "¿Permitir depuración USB?".
3. En la computadora (con `pnpm dev` corriendo en otra terminal):

```bash
pnpm android:usb                       # hace que "localhost" en el teléfono sea tu computadora
pnpm --filter @intitaxi/mobile start   # sirve el código de la app
```

4. Abre **Inti Taxi (development)** en el teléfono. Se conecta sola.

> ¿Por qué cable? Cada petición va firmada para una dirección exacta y en desarrollo los servidores se anuncian como `localhost`. `adb reverse` lo resuelve sin abrir tus servidores a la red Wi-Fi. Para usarla sin cable hay que publicar los servidores con HTTPS (paso de infraestructura para producción).

## 6. Probar la app

### Como usuario (viajar)
1. Escribe tu número (cualquier celular ecuatoriano de prueba, p. ej. `0991234567`). El código de 6 dígitos aparece en la **Bandeja** del simulador.
2. Elige **Quiero viajar**.
3. **Cuenta → Verificación de identidad**: en desarrollo, la verificación se aprueba desde el simulador (sección KYC).
4. Para tener un conductor que acepte tu viaje, en el simulador crea un **conductor aprobado** y conéctalo; luego pide un taxi desde la app.

### Como socio (trabajar)
1. En el inicio toca **Trabajar** (o **Cuenta → Trabajar con Inti Taxi**) y elige tu perfil:
   - **Nuevo conductor de taxi** · **Dueño de taxi amarillo (Taxi Ruta)** · **Dueño de furgoneta (Taxi Ruta)** · **Empresa de alquiler de autos** (pide razón social y RUC, no licencia) · **Operador de grúa**.
2. Verifica tu identidad, llena tus datos, registra tu vehículo y sube las fotos de los documentos.
3. Toca **Enviar a revisión**.
4. Aprueba la solicitud desde el **panel** (http://localhost:4100 → Conductores; para entrar al panel en desarrollo sigue `docs/modules/10-panel-administracion.md` §4) o desde el simulador (**Aprobar todos los documentos** y **Decidir conductor**). Al aprobar la matrícula, el revisor confirma la cantidad de asientos.
5. Vuelve a la app: ya puedes **Conectarte** y recibir viajes; los dueños de taxi amarillo y furgoneta piden **habilitación en una ruta** (la aprueba la operadora en el panel) y luego inician recorridos; las grúas y las empresas de alquiler ven los pedidos y el **primero que acepta** se queda con el servicio.

Puedes cambiar entre **Viajar** y **Trabajar** en cualquier momento con el selector de arriba. El servidor mantiene las dos sesiones separadas (cada una con sus propios permisos), pero no tienes que volver a iniciar sesión.

### Modo Ellxs
- Pasajerx: **Cuenta → Preferencias → Modo Ellxs**: lees y aceptas el consentimiento (es un dato sensible) y activas "Soy mujer o parte de la comunidad LGBTI". Desde entonces aparece el botón **Ellxs** para pedir viajes solo con conductorxs Ellxs.
- Conductorx: **Trabajar → Cuenta → Conductorx Ellxs** y un revisor lo aprueba en el panel.

## 7. Ejecutar las pruebas automáticas

```bash
pnpm test
```

Ejecuta las pruebas unitarias de cada paquete y las pruebas de punta a punta contra servidores reales (PostgreSQL y Redis deben estar disponibles; `pnpm dev` los deja corriendo en Docker).

## 8. Antes de publicar en Google Play (producción)

Esto **no** se hace en desarrollo y requiere cuentas y claves reales (que nunca van en el repositorio):

1. Servidores en la nube con HTTPS (ver `docs/01-arquitectura.md`), base de datos administrada y llaves en KMS.
2. Proveedores reales: SMS, verificación de identidad (KYC), pasarela de pagos, mapas, integración con ECU 911 (requiere convenio).
3. Play Integrity activado en Google Cloud y en Play Console; `EXPO_PUBLIC_PLAY_CLOUD_PROJECT` con tu número de proyecto.
4. *Certificate pinning*: `INTI_CERT_PINS` con dos huellas (actual y respaldo) — la build de producción no se genera sin ellas.
5. `npx eas-cli build --platform android --profile production` y subir el `.aab` a Play Console.
6. Revisión legal y una prueba de penetración externa (ver `docs/06-decisiones-pendientes.md` y la sección de revisión de cada módulo).

## 9. Problemas frecuentes

| Problema | Solución |
|---|---|
| `pnpm dev` dice que Docker no responde | Abre Docker Desktop y espera a que diga "Running" |
| La app dice "No pudimos iniciar la app de forma segura" | ¿Está corriendo `pnpm dev`? ¿Ejecutaste `pnpm android:usb` con el teléfono conectado? |
| La app dice que falta el módulo de seguridad | Estás en Expo Go: instala el APK de desarrollo (paso 4) |
| No llega el SMS | En desarrollo no se envían SMS reales: mira la **Bandeja** del simulador |
| "Tu teléfono usa una ubicación simulada" | Desactiva las apps de ubicación falsa en Opciones de desarrollador |
| "Para trabajar necesitas un teléfono sin modificaciones" | El modo Trabajar no se permite en teléfonos rooteados o modificados (sí puedes viajar, solo con pago en efectivo) |
