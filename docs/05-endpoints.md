# 05 — Lista de endpoints

> Estado: **PROPUESTA — pendiente de aprobación.** Se publicará como OpenAPI 3.1 en el módulo 1.

**Convenciones**
- Prefijo `/v1`. JSON. IDs UUIDv7. Errores en RFC 9457 (`application/problem+json`) sin filtrar detalles internos.
- **Auth:** `Bearer` + `DPoP` en todos los endpoints salvo los marcados 🌐 (públicos con rate limit) o 🔗 (enlace firmado).
- **Atestación** (🛡️): requiere la cabecera `X-App-Attestation` (Play Integrity / App Attest) vigente.
- **MFA** (🔐): requiere step-up reciente (`acr=mfa`, `auth_time` < 5 min).
- **Idempotencia** (♻️): requiere `Idempotency-Key`.
- **Autorización por objeto:** cada `{id}` se comprueba contra el usuario autenticado (propietario, participante del viaje o rol admin con propósito). Se indica en la columna "Autorización".
- Todos los accesos a datos de terceros y los endpoints `/admin` generan una entrada en `audit_log`.

## 1. Autenticación y sesiones (`apps/auth`)
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| GET | `/.well-known/openid-configuration` 🌐 | Descubrimiento OIDC | Pública |
| GET | `/jwks` 🌐 | Claves públicas de firma | Pública |
| POST | `/v1/auth/otp/request` 🌐🛡️ | Envía OTP por SMS (respuesta idéntica exista o no el número) | Rate limit por teléfono/dispositivo/IP |
| POST | `/v1/auth/otp/verify` 🌐🛡️ | Verifica el OTP y emite un código de autorización (PKCE) | Rate limit + bloqueo progresivo |
| POST | `/v1/auth/email/verify` | Envía y confirma el enlace de verificación del correo | Propietario |
| POST | `/oauth/token` 🌐 | `authorization_code` (PKCE) y `refresh_token` (rotativo) con DPoP | Cliente público + DPoP |
| POST | `/oauth/revoke` | Revoca tokens | Propietario |
| POST | `/v1/auth/passkeys/registration/options` · `/verify` 🛡️ | Registro de passkey | Propietario |
| POST | `/v1/auth/passkeys/authentication/options` · `/verify` 🌐🛡️ | Login con passkey | — |
| POST | `/v1/auth/device-keys` 🛡️ | Registra la clave pública protegida por biometría del dispositivo | Propietario |
| POST | `/v1/auth/device-keys/challenge` · `/assert` 🌐🛡️ | Login rápido (Face ID / huella → firma un reto) | — |
| POST | `/v1/auth/step-up` 🛡️ | MFA (passkey / OTP + correo) para operaciones sensibles | Propietario |
| GET | `/v1/auth/sessions` | Lista de sesiones y dispositivos | Propietario |
| DELETE | `/v1/auth/sessions/{id}` | Cierra una sesión (revoca la familia de refresh tokens) | Propietario |
| POST | `/v1/auth/phone/change` 🔐🛡️ | Cambio de teléfono (enfriamiento + aviso) | Propietario |
| POST | `/v1/attestation/nonce` 🌐 | Nonce para Play Integrity / App Attest | Rate limit |

## 2. Identidad, consentimientos y privacidad
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| GET/PATCH | `/v1/me` | Perfil propio | Propietario |
| DELETE | `/v1/me` 🔐 | Solicitud de eliminación de la cuenta | Propietario |
| GET/POST | `/v1/me/trusted-contacts` · DELETE `/{id}` | Contactos de confianza | Propietario |
| GET | `/v1/consents/texts/{purpose}` 🌐 | Texto vigente del consentimiento (versión + hash) | Pública |
| POST | `/v1/consents` | Otorgar un consentimiento (biometría, audio, compartir…) | Propietario |
| DELETE | `/v1/consents/{purpose}` | Revocar | Propietario |
| GET | `/v1/me/data-export` 🔐 | Derecho de acceso/portabilidad (genera un archivo cifrado asíncrono) | Propietario |
| POST | `/v1/privacy/requests` | Solicitud ARCO+ | Propietario |
| GET | `/v1/privacy/subject/{token}` 🔗 | El tercero/acompañante consulta sus datos | Token firmado de un solo titular |
| POST | `/v1/privacy/subject/{token}/confirm` · `/delete` 🔗 | El tercero confirma o pide la eliminación | Token firmado |

## 3. Verificación biométrica (KYC)
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| POST | `/v1/kyc/sessions` 🛡️ | Crea una sesión con el proveedor (exige el consentimiento `biometric_kyc`) | Propietario |
| GET | `/v1/kyc/status` | Estado de la verificación propia (sin datos biométricos) | Propietario |
| POST | `/v1/webhooks/kyc/{provider}` 🌐 | Webhook del proveedor | Firma HMAC + lista de IPs permitidas |
| POST | `/v1/driver/reverification` 🛡️ | Inicia la re-verificación aleatoria del conductor | Conductor propietario |

## 4. Conductores
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| POST | `/v1/driver/application` | Iniciar el onboarding | Usuario con KYC aprobado |
| POST | `/v1/driver/documents/upload-url` | URL prefirmada de subida (tipo, tamaño y hash fijados) | Conductor propietario |
| POST | `/v1/driver/documents` | Registrar un documento subido (dispara el análisis antivirus) | Conductor propietario |
| GET | `/v1/driver/documents` | Estado de los documentos propios | Conductor propietario |
| POST/GET | `/v1/driver/vehicles` | Registrar o ver vehículos | Conductor propietario |
| POST | `/v1/driver/online` 🛡️ | Conectarse (puede exigir re-verificación; comprueba documentos vigentes) | Conductor aprobado |
| POST | `/v1/driver/offline` | Desconectarse | Conductor |
| POST | `/v1/driver/offers/{id}/accept` · `/reject` ♻️ | Responder a una oferta de viaje | Conductor destinatario de la oferta |
| POST | `/v1/driver/trips/{id}/arrived` · `/start` · `/complete` ♻️ | Ciclo del viaje; `start` exige el PIN | Conductor asignado |
| GET | `/v1/driver/earnings` | Ganancias | Conductor propietario |
| POST | `/v1/driver/payout-accounts` 🔐 | Cuenta bancaria (tokenizada en la pasarela) + enfriamiento | Conductor propietario |
| POST | `/v1/driver/payouts` 🔐♻️ | Solicitar un retiro | Conductor propietario |

## 5. Viajes, acompañantes y terceros
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| POST | `/v1/trips/quotes` | Tarifa estimada (cotización firmada, 5 min) | Pasajero |
| POST | `/v1/trips` ♻️🛡️ | Solicitar un viaje: `quote_id`, `party` (acompañantes, menores), `for_third_party` | Pasajero con teléfono verificado |
| GET | `/v1/trips` | Historial propio (paginado) | Propietario / participante |
| GET | `/v1/trips/{id}` | Detalle (cédulas enmascaradas) | Solicitante, pasajero con cuenta o conductor asignado |
| POST | `/v1/trips/{id}/cancel` ♻️ | Cancelar | Solicitante / conductor asignado |
| GET | `/v1/trips/{id}/pin` | PIN de verificación | Solicitante o pasajero principal |
| POST | `/v1/trips/{id}/share-links` | Compartir el viaje en vivo con contactos de confianza | Participante |
| DELETE | `/v1/trips/{id}/share-links/{linkId}` | Revocar un enlace | Creador |
| POST | `/v1/trips/{id}/rating` | Calificar | Participante, una sola vez |
| GET | `/v1/trips/{id}/receipt` | Recibo | Pagador |
| POST | `/v1/trips/{id}/contact-session` | Sesión de llamada/chat enmascarado (número proxy temporal) | Participante con viaje activo |
| GET/POST | `/v1/companions` · DELETE `/{id}` | Contactos frecuentes (solo con consentimiento del acompañante) | Propietario |
| POST | `/v1/companions/validate` | Validar cédula/pasaporte y correo (mód. 10; Registro Civil si hay convenio) | Pasajero, con rate limit |
| GET | `/v1/track/{token}` 🔗 | Página/datos de seguimiento para el tercero o contacto (sin app) | Token firmado con alcance y expiración |

## 6. Tiempo real (`apps/realtime`, WebSocket `wss://rt.../v1`)
| Canal / mensaje | Descripción | Autorización |
|---|---|---|
| `connect` | Token de acceso + DPoP en el *handshake*; re-autenticación antes de expirar | Usuario autenticado |
| `driver.location` (↑) | Conductor envía la ubicación (2-4 s en viaje, 10-15 s disponible) con indicadores de mock | Conductor conectado |
| `trip.{id}.location` (↓) | Ubicación del conductor para el viaje | Participante o token de seguimiento |
| `trip.{id}.status` (↓) | Cambios de estado | Participante |
| `trip.{id}.chat` (↕) | Chat (sin números ni correos; filtro de PII) | Pasajero ↔ conductor del viaje |
| `route.{routeId}.{dir}.vehicles` (↓) | Vehículos de Taxi Ruta, asientos libres y ETA | Pasajero autenticado |
| `ops.incidents` (↓) | Feed de SOS para el centro de monitoreo | Rol `sos_operator` |

## 7. Pagos
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| POST | `/v1/payment-methods/session` | Sesión de campos alojados de la pasarela | Propietario |
| GET/DELETE | `/v1/payment-methods` · `/{id}` | Tarjetas tokenizadas (solo marca + últimos 4) | Propietario |
| GET | `/v1/wallet` | Saldo y movimientos | Propietario |
| POST | `/v1/wallet/top-ups` 🔐♻️ | Recarga (**pendiente de revisión legal**) | Propietario |
| POST | `/v1/payments/{id}/3ds-complete` | Retorno de 3-D Secure | Pagador |
| POST | `/v1/webhooks/payments/{gateway}` 🌐 | Webhooks de la pasarela | Firma + IPs permitidas + idempotencia |

## 8. Seguridad del viaje: SOS y manifiesto (`apps/sos`)
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| POST | `/v1/sos` ♻️ | Activar SOS (`trip_id`, ubicación). La app marca el 911 en paralelo | Participante del viaje activo (cuenta o enlace de acompañante) |
| POST | `/v1/sos/{id}/location` | Ubicación cada 3-5 s durante el incidente | Activador |
| POST | `/v1/sos/{id}/audio-chunks` | Fragmentos de audio cifrados (si se autorizó) | Activador |
| POST | `/v1/sos/{id}/cancel` | "Estoy bien" (exige PIN/biometría local para evitar cancelaciones bajo coacción; puede incluir un PIN de coacción) 🟡 | Activador |
| POST | `/v1/track/{token}/sos` 🔗 | SOS desde el enlace de un acompañante/tercero | Token de seguimiento |

**Adaptador ECU 911 (interno, solo mTLS, sin exposición pública)**
| Interfaz | Descripción |
|---|---|
| `Ecu911Port.reportEmergency(manifest, location)` | Implementaciones: `MockAdapter` (pruebas), `SignedLinkAdapter` (sin convenio: genera un enlace firmado para que el operador interno lo entregue), `AgreementAdapter` (protocolo del convenio, por definir) |
| `Ecu911Port.updateLocation(incidentRef, location)` | Actualización periódica |
| `Ecu911Port.close(incidentRef, outcome)` | Cierre |
| GET `/v1/authority/manifest/{token}` 🔗 | Vista de solo lectura del manifiesto para la autoridad: expiración corta, accesos contados, marca de agua y auditoría |

## 9. Taxi Ruta
| Método | Ruta | Descripción | Autorización |
|---|---|---|---|
| GET | `/v1/routes` | Rutas activas | Pasajero |
| GET | `/v1/routes/{id}` | Detalle: sentidos, polilínea, paradas ordenadas, horario, tarifa vigente ahora | Pasajero |
| POST | `/v1/routes/{id}/quotes` | Cotización por persona (subida, bajada, asientos, hora) | Pasajero |
| POST | `/v1/routes/{id}/bookings` ♻️🛡️ | Reservar asientos + acompañantes (§5.1) → crea un `trip` de tipo `fixed_route` | Pasajero |
| GET | `/v1/routes/{id}/directions/{dir}/eta?stopId=` | ETA a la parada | Pasajero |
| POST | `/v1/driver/routes/{id}/instances` 🛡️ | Conductor habilitado inicia un recorrido | Conductor con `driver_route_enablement` |
| POST | `/v1/driver/route-instances/{id}/board` · `/alight` | Registrar subida (con PIN) y bajada por reserva | Conductor de la instancia |

## 10. Administración (`/v1/admin`, solo vía ZTNA, passkey obligatoria, 🔐 para las acciones de escritura)
| Método | Ruta | Descripción | Rol |
|---|---|---|---|
| GET | `/v1/admin/drivers?status=` | Cola de aprobación | `driver_reviewer` |
| GET | `/v1/admin/drivers/{id}/documents/{docId}/view-url` | URL prefirmada de 60 s (motivo obligatorio) | `driver_reviewer` |
| POST | `/v1/admin/drivers/{id}/approve` · `/reject` · `/suspend` | Decisión | `driver_reviewer` (no sobre sí mismo) |
| POST/DELETE | `/v1/admin/drivers/{id}/route-enablements` | Habilitar o retirar un conductor de una ruta | `route_manager` |
| GET/POST/PATCH | `/v1/admin/routes` · `/{id}` · `/{id}/directions` · `/{id}/stops` · `/{id}/fares` · `/{id}/schedules` | CRUD de Taxi Ruta (borrador → publicar) | `route_manager` |
| POST | `/v1/admin/routes/{id}/validate` | Valida el orden de las paradas con la API de mapas y devuelve correcciones propuestas | `route_manager` |
| POST | `/v1/admin/routes/{id}/publish` | Publicar (doble aprobación) | `route_manager` + segundo aprobador |
| GET/PATCH | `/v1/admin/disputes` · `/{id}` | Disputas | `support` |
| GET | `/v1/admin/fraud/signals` · POST `/cases` | Fraude | `fraud_analyst` |
| GET | `/v1/admin/incidents` · `/{id}` | Centro de monitoreo SOS | `sos_operator` |
| POST | `/v1/admin/incidents/{id}/authority-link` | Generar el enlace firmado para la autoridad (base legal + segundo aprobador) | `sos_operator` + `dpo` |
| GET | `/v1/admin/trips/{id}/manifest` | Ver el manifiesto (motivo obligatorio, auditado) | `support` / `sos_operator` / `auditor` |
| GET | `/v1/admin/audit-log` | Consulta de auditoría (solo lectura) | `auditor` |
| GET/PATCH | `/v1/admin/privacy/requests` | Gestión de solicitudes ARCO+ | `dpo` |
| GET/POST/DELETE | `/v1/admin/users/{id}/roles` | Asignación de roles (con expiración) | `super_admin` |
| GET | `/v1/admin/metrics` | Métricas agregadas (sin PII) | Cualquier rol admin |

## 11. Operación
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/healthz` · `/readyz` | Solo accesibles desde la red interna / ALB |
