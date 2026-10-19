# Módulo 5 — Acompañantes y viajes para terceros

> Estado: **completado** — 2026-10-19. Pruebas: 14 unitarias (cédula módulo 10, pasaporte, nombres) y 7 de extremo a extremo.

## 1. Qué incluye

| Componente | Ubicación |
|---|---|
| Registro del grupo al pedir el viaje (hook del módulo de viajes) | `apps/api/src/modules/people/people.service.ts` |
| Validación de personas (cédula mód. 10, pasaporte, correo, menores) | `people/person-input.ts`, `packages/domain/src/identity-docs.ts` |
| Contactos frecuentes con consentimiento del acompañante | `people.service.ts` |
| Portal del titular (consultar / confirmar / pedir eliminación) | `GET/POST /v1/privacy/subject/{token}` |
| Notificaciones (a usuarios vía auth; a terceros directamente) | `modules/notifications`, `apps/auth/.../internal/notify.controller.ts` |
| Retención de 180 días con anonimización | `PeopleService.purgeExpired` |
| Migración | `0008_people.sql` |

## 2. Reglas

- **Quién queda registrado:** siempre el solicitante (con su nombre verificado si pasó KYC), el pasajero principal y cada acompañante. Roles: `requester`, `primary_passenger` y `companion`.
- **Adultos:** nombres, apellidos, cédula (validada con el dígito verificador) o pasaporte + país, y correo.
- **Menores:** sin correo y con cédula opcional, pero siempre con un **adulto responsable que viaja** (el solicitante, el pasajero principal o un acompañante adulto).
- **Capacidad:** máximo 8 personas, y el viaje solo se ofrece a vehículos con asientos suficientes.
- **Viaje para un tercero:** se registran sus datos y su teléfono. Al aceptarse el viaje recibe por SMS y correo el conductor, el vehículo, la placa, **el PIN** y un enlace de seguimiento en vivo (el seguimiento se completa en el módulo 6). Cuando llega, quien lo pidió recibe un aviso.
- **Aviso LOPDP:** cada persona registrada con correo recibe la finalidad (seguridad y emergencias), el plazo (180 días) y un enlace para consultar, confirmar o pedir la eliminación.
- **Eliminación:** inmediata si el viaje terminó sin incidente. Si el viaje está activo o tiene un incidente, queda **diferida** y registrada (`deferred_legal_hold`) y se ejecuta al cerrarse.
- **Contactos frecuentes:** solo se usan después de que el acompañante confirme por su enlace. Para un menor, el adulto declara la representación (⚠️ requiere revisión legal).
- **Retención:** a los 180 días del fin del viaje se anonimizan las personas (borrado criptográfico: los campos cifrados quedan en NULL) y las direcciones de texto, **salvo** viajes con `incident_hold`.

## 3. Endpoints

| Método | Ruta | Protección |
|---|---|---|
| POST | `/v1/trips` (+ `companions`, `savedCompanionIds`, `forThirdParty`) | Igual que el módulo 4 |
| GET | `/v1/trips/{id}/parties` | Participantes; **el conductor solo ve el nombre del pasajero principal** |
| GET/POST/DELETE | `/v1/companions` | Token; solo los propios |
| GET | `/v1/privacy/subject/{token}` | Enlace firmado de un solo titular (30 días) + límite por IP |
| POST | `/v1/privacy/subject/{token}/confirm` · `/delete` | Igual |
| POST | `/internal/v1/notify` (auth) | Solo servicios internos firmados |

## 4. Riesgos de seguridad y cómo se mitigan

| # | Riesgo | Mitigación | Prueba |
|---|---|---|---|
| R1 | **Datos de terceros sin su conocimiento** | Aviso LOPDP individual con finalidad, plazo y enlace de derechos; registro de `notified_at` | `registra acompañantes…` |
| R2 | **Exposición de cédulas** | Cifrado por campo + índice ciego; en la app siempre `09******23`; el conductor no ve documentos | `registra acompañantes…`, `el tercero recibe…` |
| R3 | **Acceso indebido a datos del grupo** | Solo participantes del viaje; cada lectura se audita con `purpose=trip_safety` | Auditoría en e2e |
| R4 | **Uso de contactos frecuentes sin permiso** | Estado `pending` hasta que el acompañante confirma; solo el propietario puede usarlos (404 para otros) | `contactos frecuentes…` |
| R5 | **Menores sin adulto responsable** | Validación obligatoria del responsable, que debe ser un adulto del mismo viaje | `menores…` |
| R6 | **Sobrecupo** | Máximo 8 y emparejamiento solo con vehículos con asientos suficientes | `no supera la capacidad…` |
| R7 | **Retención excesiva** | Anonimización automática a los 180 días (configurable), respetando la retención legal por incidente | `retención…` |
| R8 | **Enumeración / abuso de enlaces del titular** | Tokens de 256 bits guardados como hash, con expiración y límite por IP; 404 indistinguible | `el acompañante consulta sus datos…` |
| R9 | **Fuga de contacto de usuarios hacia la API** | Las notificaciones a usuarios pasan por auth (llamada interna firmada); la API no guarda su teléfono | e2e de llegada |

### Riesgos residuales
- **Validación con Registro Civil / DINARDAP:** no disponible sin convenio. Hoy se valida la forma y el dígito verificador, no la existencia ni el nombre.
- **Menores:** la representación declarada por el adulto requiere revisión legal; no hay verificación de parentesco.
- La **página web del portal del titular** (`SUBJECT_PORTAL_URL`) y la de seguimiento se sirven en el módulo 6 / panel; hoy existe la API.

## 5. Revisión legal requerida
Base legal del tratamiento de datos de terceros y menores (¿interés vital o consentimiento?), textos de los avisos, plazo de 180 días y criterio de diferir la eliminación ante incidentes.
