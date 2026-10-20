# Documentación — Inti Taxi

| Documento | Contenido |
|---|---|
| [00-especificacion.md](00-especificacion.md) | Especificación de referencia del proyecto |
| [01-arquitectura.md](01-arquitectura.md) | Arquitectura (diagramas Mermaid), stack recomendado, justificación de KYC y pasarela de pagos |
| [02-estructura-monorepo.md](02-estructura-monorepo.md) | Estructura de carpetas y reglas del repositorio |
| [03-modelo-datos.md](03-modelo-datos.md) | Modelo de datos (ER), manifiesto, acompañantes, rutas, paradas, tarifas, retención |
| [04-modelo-amenazas-stride.md](04-modelo-amenazas-stride.md) | Modelo de amenazas STRIDE por componente |
| [05-endpoints.md](05-endpoints.md) | Lista de endpoints REST/WebSocket con autorización |
| [06-decisiones-pendientes.md](06-decisiones-pendientes.md) | Decisiones que requieren aprobación y partes que requieren revisión legal |

> **¿Primera vez?** Empieza por [COMO-EJECUTAR.md](COMO-EJECUTAR.md): instalar, arrancar los servidores e instalar la app en Android.

## Módulos (implementación)

| Módulo | Documento |
|---|---|
| 1. Autenticación y sesiones | [modules/01-autenticacion.md](modules/01-autenticacion.md) |
| 2. Verificación biométrica | [modules/02-verificacion-biometrica.md](modules/02-verificacion-biometrica.md) |
| 3. Onboarding de conductores | [modules/03-onboarding-conductores.md](modules/03-onboarding-conductores.md) |
| 4. Solicitud y emparejamiento | [modules/04-viajes-emparejamiento.md](modules/04-viajes-emparejamiento.md) |
| 5. Acompañantes y terceros | [modules/05-acompanantes-terceros.md](modules/05-acompanantes-terceros.md) |
| 6. Tiempo real | [modules/06-tiempo-real.md](modules/06-tiempo-real.md) |
| 7. Pagos | [modules/07-pagos.md](modules/07-pagos.md) |
| 8. PIN, SOS, manifiesto y ECU 911 | [modules/08-seguridad-viaje-sos.md](modules/08-seguridad-viaje-sos.md) |
| 9. Taxi Ruta | [modules/09-taxi-ruta.md](modules/09-taxi-ruta.md) |
| 10. Panel de administración | [modules/10-panel-administracion.md](modules/10-panel-administracion.md) |
| 11. App Android de pasajero | [modules/11-app-android-pasajero.md](modules/11-app-android-pasajero.md) |
| 13. App única (viajar y trabajar), menú de socios, Modo Ellxs y rediseño | [modules/13-app-unica-socios.md](modules/13-app-unica-socios.md) |
| 12. Furgonetas, tarifa dinámica, reputación, chat multimedia, reportes, grúas y alquiler, Modo Ella, Inti Puntos y nuevo diseño | [modules/12-furgonetas-reputacion-asistencia.md](modules/12-furgonetas-reputacion-asistencia.md) |

Estado: **diseño aprobado el 2026-10-19** (decisiones en `06-decisiones-pendientes.md` §0) y **los 10 módulos implementados** con pruebas, más la **app Android de pasajero**. Pendiente antes de producción: app de conductor, revisiones legales y auditorías humanas (§3 de `06-decisiones-pendientes.md` y la sección final de cada módulo) e infraestructura en la nube.
