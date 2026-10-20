# Módulo 13 — App única (viajar y trabajar), menú de socios, Modo Ellxs y rediseño

> Estado: **implementado y probado** — 2026-10-20. Backend: `e2e/tests/m13-app-unica-socios.e2e.test.ts`, `m12g` actualizado, pruebas de integración de `apps/auth`. App: tipos, pruebas unitarias, compilación a bytecode Hermes y 2 pruebas de punta a punta del cliente móvil (`m11`). **No verificado aquí:** el APK en un teléfono real (ver `docs/COMO-EJECUTAR.md`).

## 1. Decisiones del propietario del producto

| Tema | Decisión |
|---|---|
| Modo Ella → **Modo Ellxs** | Viajes para **mujeres y personas LGBTI** (pasajerxs), atendidos por conductorxs **mujeres o LGBTI aprobadxs** por una persona del equipo. Etiquetas: "Modo Ellxs", "Conductorx Ellxs", insignia "Ellxs" |
| Una sola app Android | `ec.intitaxi.app` para pasajeros y socios. Desde el menú, el socio se registra como: **nuevo conductor de taxi**, **empresa de alquiler de autos**, **dueño de taxi amarillo (Taxi Ruta)**, **dueño de furgoneta (Taxi Ruta)** u **operador de grúa** |

## 2. Qué se hizo (backend)

### 2.1 Modo Ellxs (BD + API)
- Migración `0024_ellxs.sql`: renombra `people.passenger_profiles.self_identifies_woman → ellxs_member`, `drivers.profiles.women_rides_* → ellxs_requested_at / ellxs_approved_at / ellxs_approved_by` y `trips.trips.women_only → ellxs_only` (no había restricciones ni índices con esos nombres) y publica el texto de consentimiento versionado `ellxs` v1 (borrador para revisión legal).
- `GET/PUT /v1/me/preferences`: el campo es `ellxsMember` (un solo sí/no **a propósito**: no revela si la persona es mujer o LGBTI). Activarlo es tratamiento de **dato sensible** (LOPDP art. 26): exige el consentimiento vigente `ellxs` (`GET /v1/consents/texts/ellxs` → `POST /v1/consents`); sin él responde **409 `consent_required`**. Desactivarlo borra la autodeclaración **y** registra la revocación del consentimiento; revocar el consentimiento (`DELETE /v1/consents/ellxs`) también borra la autodeclaración. La auditoría solo guarda qué campos cambiaron, nunca el valor.
- Viajes: `POST /v1/trips` acepta `ellxsOnly`; exige `ellxsMember = true` (si no, **409 `ellxs_not_enabled`**) y el emparejamiento solo ofrece el viaje a conductorxs con `ellxs_approved_at`. La vista del viaje y la oferta muestran `ellxsOnly`; la tarjeta del conductor, `badges.ellxs`.
- Conductorxs: `POST /v1/driver/ellxs/request`; panel (`driver_reviewer`): `GET /v1/admin/drivers/ellxs/pending` y `POST /v1/admin/drivers/{id}/ellxs { approve }`. Se eliminaron las rutas `women-rides`.
- Simulador: acciones y sección "Inclusión · Modo Ellxs" (consentimiento, activar/desactivar, pedir y aprobar Conductorx Ellxs, viaje con `ellxsOnly`).

### 2.2 Tipos de socio
- Migración `0025_partner_kinds.sql`: `drivers.profiles.partner_kind` (`taxi_driver` por omisión, `route_taxi_owner`, `van_owner`, `rental_company`, `tow_operator`), `business_name`, RUC cifrado (`ruc_enc`, `FieldCipher` con AAD `drivers.profiles.ruc:<usuario>`), índice ciego único (`ruc_hmac`, `BlindIndex` con contexto `company_ruc`) y versión enmascarada (`ruc_masked`) — igual que la licencia. La licencia pasa a ser opcional **solo** para `rental_company` (restricción `profiles_partner_requirements` en la BD). Nuevo documento `company_ruc` (certificado del RUC).
- `POST /v1/driver/application` con `partnerKind` (sin él = `taxi_driver`, compatible con la app anterior). Empresa de alquiler: `company { businessName, ruc }` obligatorio, sin licencia; demás tipos: licencia como antes. KYC aprobado de quien envía la solicitud para todos los tipos. Validador puro `validRuc` en `packages/domain` (13 dígitos, provincia 01–24 o 30, termina en `001`).
- Reglas puras en `apps/api/src/modules/drivers/eligibility.ts` (probadas): vehículos permitidos por tipo (`taxi_driver`/`route_taxi_owner` → `taxi`, `van_owner` → `van`, `rental_company` → `rental`, `tow_operator` → `tow`; otro tipo → **400 `vehicle_type_not_allowed`**) y documentos exigidos (personales `license` + `background_check`, o `company_ruc` para alquiler; por vehículo `registration` + `insurance`). La elegibilidad solo cuenta vehículos del tipo permitido; subir un documento que no se exige al tipo → **400 `document_type_not_allowed`**.
- `GET /v1/driver/profile` añade `partnerKind`, `company { businessName, rucMasked } | null`, `allowedVehicleTypes`, `requiredDocs { personal, vehicle }` e `issues` (para aprobación mientras está en `applicant`/`under_review`; para operar en los demás estados). `license` es `null` para alquiler. Solo valores enmascarados (probado: el JSON no contiene el RUC ni la licencia completos).
- Panel: la cola y el detalle muestran el tipo de socio y la razón social (`apps/admin-web`, vista "Conductores").

### 2.3 Solicitudes de habilitación en Taxi Ruta
- Migración `0026_route_enablement_requests.sql`: `fixed_routes.enablement_requests` (una pendiente por socio y ruta, índice único parcial).
- Socio: `GET /v1/driver/routes/catalog` (rutas activas, horario, si ya está habilitado y su última solicitud) y `POST /v1/driver/routes/{id}/enablement-requests { vehicleId }`: solo socios **aprobados** `route_taxi_owner`, `van_owner` (y `taxi_driver` con un taxi), con un vehículo **propio y aprobado** de tipo `taxi`/`van` permitido para su tipo; 409 `already_enabled` / `request_pending`.
- Panel (`route_manager`): `GET /v1/admin/routes/enablement-requests?status=` (nombre de pila verificado, tipo de socio, placa/tipo/asientos, código de ruta) y `POST /v1/admin/routes/enablement-requests/{id}/decision { approve, reason? }`. Aprobar reutiliza la misma lógica que `POST /v1/admin/routes/{id}/drivers` (ahora dentro de la misma transacción) y vuelve a comprobar que el vehículo siga aprobado. Todo auditado (`route.enablement_request`, `route.driver_enable`, `route.enablement_decision`). Vista en el panel web ("Taxi Ruta" → "Solicitudes de habilitación desde la app").

### 2.4 Una app, dos clientes OAuth (token exchange)
- La app única inicia sesión **una vez** como `intitaxi-passenger` y obtiene la sesión `intitaxi-driver` **sin otro SMS** con el grant RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange` en `POST /oauth/token` (detalle en `05-endpoints.md` §1b).
- `packages/auth-client`: `TokenManager.exchangeToken(subjectAccessToken)` y opción `refreshTokenKey` para que el TokenManager de pasajero y el de socio no compartan la misma entrada del almacenamiento seguro.
- Configuración: `ANDROID_PACKAGE_NAMES` incluye `ec.intitaxi.app`; `PLAY_INTEGRITY_ALLOW_BASIC_PACKAGES` = `ec.intitaxi.app,ec.intitaxi.passenger` (`.env.example` actualizado).
- `AttestationGuard` (`packages/nest-common`): con un token del cliente `intitaxi-driver`, un dispositivo con `device_integrity_basic_only` recibe **403 `device_not_trusted`** ("Para trabajar con Inti Taxi necesitas un teléfono sin modificaciones (integridad completa de Google Play).").

## 3. Riesgos de seguridad y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Exposición de la orientación o identidad de género (dato sensible) | Un solo booleano `ellxsMember` que no dice a qué grupo pertenece la persona; nunca se pregunta; solo se guarda con consentimiento explícito y versionado (registro de solo inserción con versión y hash del texto); no aparece en la tarjeta del pasajero que ve quien conduce; la auditoría no guarda el valor; desactivar o revocar el consentimiento lo borra |
| Inferencia por el viaje: la conductorx sabe que el viaje es Ellxs | Inherente a la función (solo se ofrece a Conductorxs Ellxs). Se informa en el texto del consentimiento; la oferta no incluye nada más del pasajero |
| Hombres que se autodeclaran para entrar a Modo Ellxs | La autodeclaración del pasajero no se verifica (decisión de producto para no pedir pruebas de identidad de género). La protección está del lado del conductor: solo conductorxs aprobadxs por una persona del equipo; reportes y sanciones del módulo 12 aplican |
| Conductor que se hace pasar por Conductorx Ellxs | Habilitación solo tras verificación humana (`driver_reviewer`), nunca automática; nadie se aprueba a sí mismo; se puede retirar en cualquier momento; todo auditado |
| Robo de un token de pasajero para obtener una sesión de socio | El canje exige una prueba DPoP de la **misma** clave del token (`cnf.jkt`) y el mismo dispositivo/sesión; la sesión de origen debe estar activa (revocación en Redis y en BD) y el usuario activo; intentos denegados auditados |
| Escalada de privilegios al cambiar de cliente | Solo entre clientes móviles distintos (`invalid_target` para pasajero → pasajero o hacia el panel); se copian `acr`/`amr`/`auth_time` (sin elevación); la API de socio sigue exigiendo sus propios requisitos (KYC, aprobación, documentos) |
| Acumulación de sesiones por cambios repetidos | Una sola sesión por dispositivo y cliente de destino (la anterior se revoca con `client_switch_replaced`); límite de 10 cambios por usuario y hora |
| Teléfonos rooteados usados para trabajar (GPS falso, apps modificadas) | La app única tolera integridad básica para **viajar**; `AttestationGuard` niega toda ruta atestada al cliente `intitaxi-driver` en esos teléfonos (`device_not_trusted`) |
| Fuga del RUC o de la licencia | Cifrados con AAD por usuario; unicidad con índice ciego (HMAC); las vistas (socio y panel) solo devuelven la versión enmascarada; no se auditan los valores |
| Un socio registra vehículos o documentos que no le corresponden | Lista cerrada de tipos de vehículo y documentos por tipo de socio (pura, probada) aplicada en la API; la elegibilidad ignora vehículos de otro tipo |
| Empresas falsas (RUC inventado) | `validRuc` solo valida la forma; el certificado del RUC (`company_ruc`) lo revisa una persona antes de aprobar (ver §4) |
| IDOR en las solicitudes de Taxi Ruta | El vehículo debe pertenecer al socio que pide; el panel exige `route_manager`; nadie decide su propia solicitud; una sola solicitud pendiente por socio y ruta (índice único) y límite diario |
| Aprobar con un vehículo que ya no está en regla | Al decidir se revalida que el vehículo siga aprobado y la habilitación se crea en la misma transacción que la decisión |

## 4. Requiere revisión legal o auditoría humana

1. **LOPDP — dato sensible en Modo Ellxs:** revisar el texto del consentimiento `ellxs` (borrador), la base legal (consentimiento explícito, art. 26), la evaluación de impacto (EIPD), el registro de actividades de tratamiento y el plazo de conservación del registro de consentimientos. Confirmar con asesoría legal que un filtro de conductorxs por género/orientación no constituye discriminación prohibida (Constitución art. 11) y redactar los textos con organizaciones LGBTI de Guayaquil.
2. **Verificación de Conductorxs Ellxs:** definir el procedimiento humano (qué se puede preguntar y qué no, cómo se documenta sin registrar la orientación o identidad, quién revisa, cómo se apela y cómo se retira la habilitación). Hoy el sistema solo guarda quién aprobó y cuándo.
3. **Empresas de alquiler:** verificación del RUC contra el SRI (estado activo, actividad económica de alquiler de vehículos), representante legal (hoy el KYC es de la persona que envía la solicitud, no necesariamente el representante), contrato tipo de alquiler, seguros obligatorios y facturación.
4. **Criterios de habilitación en Taxi Ruta:** qué requisitos debe cumplir un dueño de taxi amarillo o de furgoneta para operar una ruta (permiso de operación de la cooperativa/compañía, ATM/ANT, cupos por ruta, revisión técnica), y si debe existir un segundo aprobador (hoy decide una sola persona con rol `route_manager`).
5. **Pentest** del token exchange y de la app única antes del lanzamiento.

## 5. Variables (`.env.example`)

Cambian los valores por omisión de `ANDROID_PACKAGE_NAMES` (`ec.intitaxi.app,ec.intitaxi.passenger,ec.intitaxi.driver`) y `PLAY_INTEGRITY_ALLOW_BASIC_PACKAGES` (`ec.intitaxi.app,ec.intitaxi.passenger`). No hay variables nuevas.

## 6. App (`apps/mobile`, antes `apps/mobile-passenger`)

Una sola app, paquete `ec.intitaxi.app`, con un selector **Viajar | Trabajar** arriba del inicio. Abre en el último modo usado.

### 6.1 Cómo se separan los dos modos
- Al iniciar sesión (SMS o passkey) se abre la sesión de **pasajero** (`intitaxi-passenger`).
- Al entrar a Trabajar, la app obtiene la sesión de **socio** (`intitaxi-driver`) por intercambio de tokens, sin otro SMS y con la **misma clave de hardware** (Keystore/StrongBox). Los refresh tokens se guardan en claves distintas del almacenamiento seguro (`partner.` como prefijo), así que una sesión no pisa a la otra.
- Cerrar sesión cierra ambas. En teléfonos rooteados o modificados se puede viajar (solo efectivo), pero el modo Trabajar responde `device_not_trusted`.

### 6.2 Pantallas nuevas
| Pantalla | Qué hace |
|---|---|
| **¿Cómo quieres usar Inti Taxi?** (`RoleMenu`) | Al registrarse y desde Cuenta → Trabajar con Inti Taxi: *Quiero viajar* o uno de los 5 perfiles de socio |
| **Alta de socio** (`partner/Apply`) | Identidad verificada (obligatoria), licencia profesional o, para empresas de alquiler, razón social + RUC |
| **Registro** (`partner/Setup`) | Lista de documentos según el perfil, vehículos (tipo y rango de asientos según el perfil), fotos de documentos con cámara o galería (SHA-256 calculado en el teléfono, revisión del archivo en el servidor) y **Enviar a revisión**; muestra estado y motivos de rechazo |
| **Trabajo** (`partner/WorkHome`) | Conectarse con un vehículo aprobado, ubicación en vivo mientras está conectado, **ofertas** con precio, extra dinámico (100 % para el conductor), distancia, calificación y viajes del pasajero, preferencias y si es Ellxs/Aliado; pestañas Ganancias y Cuenta |
| **Viaje del conductor** (`partner/DriverTrip`) | Datos del pasajero (nombre elegido si lo tiene), navegar, chat con voz/foto/video, Llegué → PIN → Terminar, **calificar al pasajero** con etiquetas, reportar al pasajero |
| **Taxi Ruta del dueño** (`partner/RouteWork`) | Catálogo de rutas, **pedir habilitación**, iniciar recorrido (ida/vuelta), subir pasajeros con su PIN (muestra la tarifa fijada), bajarlos y terminar |
| **Grúa / alquiler** (`partner/AssistWork`) | Pedidos abiertos (zona aproximada hasta aceptar), aceptar (el primero gana), avanzar por pasos, cobro en efectivo |
| **Conductor Aliado** y **Conductorx Ellxs** | Curso con evaluación; solicitud Ellxs que aprueba un revisor |
| **Modo Ellxs** (pasajerx) | Preferencias → consentimiento explícito con el texto legal vigente → "Soy mujer o parte de la comunidad LGBTI"; botón **Ellxs** en el inicio |

### 6.3 Rediseño
Sistema de diseño en `src/ui/kit.tsx`: negro profundo `#09090B`, dorado `#D9AE52`, títulos con serifa, tarjetas de 20 px de radio, rótulos en mayúsculas espaciadas y un solo acento por pantalla. Componentes nuevos: `Segmented`, `ListItem`, `IconCircle`, `Pill`, `Stat`, `TabBar`, `Empty` y `PrideBar` (franja arcoíris discreta de Ellxs). Vista previa en la conversación (`app-unica.png`).

### 6.4 Riesgos de la app y cómo se mitigan
| Riesgo | Mitigación |
|---|---|
| Que la sesión de pasajero dé acceso a funciones de socio | Clientes OAuth separados: el servidor revisa el cliente en cada endpoint de socio (probado: 403). El intercambio exige la misma clave DPoP (probado: otro teléfono no puede) |
| Robo del token de socio | El refresh token queda ligado a la clave del Keystore; se guarda cifrado en `expo-secure-store` sin copia de seguridad |
| Documentos falsificados o con malware | Huella SHA-256 calculada en el teléfono y comprobada por el servidor; revisión del tipo real del archivo; revisión humana |
| Ubicación falsa del conductor | Se detecta la ubicación simulada al conectarse (no deja conectarse) y en cada envío se informa al servidor, que la registra como señal de fraude |
| Exposición de datos del pasajero antes de aceptar | La oferta muestra solo distancia, precio, calificación y preferencias; el nombre y el detalle llegan al aceptar. Grúa/alquiler: zona aproximada hasta aceptar |
| Dato sensible de Ellxs | Consentimiento explícito y separado; no se pregunta a qué grupo pertenece; nunca se muestra al conductor; desactivarlo lo borra |

**Limitación conocida:** la ubicación del socio se comparte solo con la app abierta (no se pide ubicación en segundo plano). Para trabajar con la pantalla apagada hace falta ubicación en segundo plano, con la declaración correspondiente en Google Play; queda como siguiente paso.
