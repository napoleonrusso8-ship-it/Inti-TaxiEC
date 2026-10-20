# Módulo 12 — Furgonetas, tarifa dinámica, reputación, chat multimedia, reportes, grúas y alquiler, inclusión, puntos y nuevo diseño

> Estado: **implementado y probado** — 2026-10-20. Backend completo con pruebas de extremo a extremo (`e2e/tests/m12a…m12g`); app de pasajero rediseñada con las pantallas nuevas (tipos, pruebas unitarias y compilación a bytecode Hermes verificadas aquí; el APK se compila en EAS o Android Studio, ver módulo 11). **Pendiente:** app de conductor (las APIs del lado del conductor ya existen y las usa el simulador).

## 1. Decisiones tomadas contigo

| Tema | Decisión |
|---|---|
| Comisión | **9 %** de la tarifa base en viajes a demanda. En **Taxi Ruta** no hay porcentaje: **$0,90 por recorrido de taxi** y **$2,50 por recorrido de furgoneta** (se cobra una vez por recorrido terminado con al menos un pasajero, no por persona). Grúa y alquiler: 9 % (configurable). Todo se cambia en el panel (`super_admin`, con límites máximos) |
| Tarifa dinámica | Tope **1,5×**, en pasos de 0,05. El **100 % del extra va al conductor** (la comisión se calcula solo sobre la base). El pasajero ve el precio cerrado y el desglose antes de pedir |
| Furgonetas Taxi Ruta | $2,80 por persona primera franja y $3,80 segunda (Ruta 1). 5–15 asientos declarados y **confirmados por un revisor** al aprobar la matrícula |
| Reasignación | Hasta **5** cambios de unidad (taxi y Taxi Ruta); al sexto el viaje/reserva se cierra. Si el conductor ya había llegado, la plataforma le compensa $1,00 (gasto promocional, no lo paga el pasajero) |
| Chat | Texto, notas de voz (≤ 60 s), fotos y videos (≤ 20 s), desde la asignación hasta el destino. Se conservan **30 días** (más si hay reporte o SOS) |
| Grúas y alquiler | El usuario **oferta** lo que quiere pagar; la app sugiere un rango justo; **el primero que acepta** gana. Fase 1: pago en efectivo al proveedor |
| Novedades | Alerta de desvío, Modo Ella, Conductor Aliado (LGBTI), viaje silencioso y preferencias, Inti Puntos |

## 2. Qué incluye

**Backend (`apps/api`)**
- Vehículos `taxi` (1–4 asientos), `van` (5–15), `tow` (1–2) y `rental` (1–8, con categoría). Asientos verificados por revisor.
- `CommissionService` y `/v1/admin/commissions`.
- Tarifa dinámica (`packages/domain/surge.ts`): oferta/demanda por zona, tope configurable (`SURGE_MAX`), apagable (`SURGE_ENABLED`).
- Perfil público del conductor: calificación, viajes, antigüedad, etiquetas positivas, insignias (identidad verificada, Aliado, Conductora). El conductor ve la calificación y el número de viajes del pasajero, y lo califica al terminar.
- Chat multimedia (`ChatModule`): subida a almacenamiento con URL firmada, inspección del archivo en el servidor (tipo real por "magic bytes", duración del MP4, eliminación de metadatos EXIF/GPS, detección de malware de prueba), descarga con URL de 60 s, purga a 30 días y retención legal.
- Reportes y sanciones (`TrustModule`, rol `trust_safety`): reporte con instantánea cifrada del chat y pruebas marcadas; el agente **debe registrar el contacto con el reportado** antes de decidir; suspensión de 1 a 30 días; expulsión con aprobación de una segunda persona; revocación; aviso por SMS; las sanciones bloquean pedir viajes o conectarse.
- Grúas y alquiler (`AssistModule`): sugerencia de precio, oferta, subir oferta, aceptación atómica (solo uno gana), avance, comisión en el libro contable, vencimiento automático. Alquiler exige KYC.
- Comunidad (`CommunityModule`): preferencias, Modo Ella (solicitud de conductora + aprobación), curso Conductor Aliado, mascota/silla de ruedas por vehículo, Inti Puntos (1 punto por dólar; 100 puntos = $1; canje desde 500, máx. 2000 al mes) y **alerta de desvío** (detecta alejamiento del destino o parada larga; pregunta solo al pasajero; sin respuesta o con "ayuda" escala al servicio SOS).

**App de pasajero (`apps/mobile`, antes `apps/mobile-passenger`)** — nuevo diseño negro y dorado, títulos con serifa:
- Inicio con mapa oscuro y servicios: Taxi, Taxi Ruta, Furgoneta, Grúa, Alquiler, Modo Ella; preferencias rápidas; Inti Puntos.
- Pedir taxi con preferencias, Modo Ella, "solo Conductores Aliados" y desglose de la tarifa dinámica.
- Viaje: perfil del conductor, PIN, chat/voz/foto/video, "otra unidad (x de 5)", comprobación "¿estás bien?", SOS, calificación con etiquetas, reporte.
- **Chat**: texto en tiempo real, grabación de voz con límite, cámara/galería para fotos y videos de 20 s, reproducción bajo demanda.
- **Reportar**: categoría, relato, selección de pruebas del chat; "Mis reportes".
- **Taxi Ruta / Furgonetas**: filtro por tipo, tarifas por tipo, vehículos con tarifa por persona, reserva con perfil del conductor y **cambio de unidad**.
- **Grúa** y **Alquiler**: selector de oferta (−/+) con rango sugerido, estado en vivo, subir oferta, cancelar, calificar.
- **Preferencias** (nombre elegido, Modo Ella, alerta de desvío, preferencias por defecto) y **Inti Puntos** (saldo, canje, movimientos).

## 3. Riesgos de seguridad y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Archivos maliciosos en el chat (malware, archivos disfrazados, bombas de tamaño) | Tipo validado por contenido real, tamaño máximo por tipo, duración verificada en el servidor, archivos que no cumplen se rechazan y se auditan; descarga por URL firmada de 60 s; no se guardan en el teléfono |
| Fuga de ubicación por fotos | Se eliminan EXIF y metadatos PNG antes de entregar la foto; la app pide la imagen sin EXIF |
| Acoso por chat | Límite de mensajes por minuto y de archivos por viaje; datos personales (teléfonos, correos) se ocultan en el texto; el chat se cierra al llegar al destino; el reporte congela el chat y los archivos como prueba |
| Reportes falsos o venganza | Sanción solo tras investigación con contacto obligatorio a la otra parte; la expulsión requiere a una segunda persona; todo queda en auditoría encadenada; el reporte falso también se sanciona |
| Abuso de la reasignación (hacer ir y venir a conductores) | Máximo 5; el sexto cierra el viaje; compensación al conductor si ya había llegado; cada cambio queda auditado |
| Manipulación de la tarifa dinámica (conductores que se desconectan en grupo) | Tope de 1,5×, el extra se fija en la cotización (precio cerrado) y se puede apagar al instante con `SURGE_ENABLED` |
| Carrera al aceptar grúa/alquiler | `UPDATE … WHERE status = 'open'` atómico: solo un proveedor gana (probado) |
| Ofertas absurdas (muy bajas o infladas para lavar dinero) | La oferta debe estar entre el 50 % del mínimo sugerido y 3 veces el máximo |
| Exposición de datos de género/orientación | **Nunca** se pregunta orientación ni identidad de género. "Modo Ella" es una autodeclaración solo para habilitar conductoras; el nombre elegido se guarda cifrado; el conductor solo ve el nombre a mostrar |
| Conductor peligroso que desvía la ruta | Alerta de desvío y parada larga, preguntando **solo al pasajero** (el conductor no se entera); sin respuesta, escala a SOS con la última ubicación |
| Canje fraudulento de puntos | Puntos solo por viajes pagados y terminados (únicos por viaje), canje con mínimo y tope mensual, libro de puntos de solo inserción |
| Permisos del teléfono | Micrófono y cámara se piden solo al usarlos; sin ubicación en segundo plano ni almacenamiento |

## 4. Requiere revisión legal o auditoría humana

1. **Tarifa dinámica:** confirmar con la ATM / ordenanzas de Guayaquil y la Ley de Defensa del Consumidor si se permite cobrar más que la tarifa regulada de taxi y cómo informarlo. Hasta tener la respuesta, se puede apagar con `SURGE_ENABLED=false`.
2. **Comisión fija en Taxi Ruta y relación con los conductores:** contratos, facturación (SRI) y si la comisión por recorrido debe constar en el recibo.
3. **Alquiler entre particulares:** contrato tipo, seguro obligatorio, verificación de licencia, depósito/garantía, responsabilidad ante accidentes y multas, permisos municipales. La app solo conecta; el contrato se firma al entregar.
4. **Grúas:** permisos de operación y tarifas máximas que pudiera fijar la autoridad; responsabilidad por daños al vehículo remolcado.
5. **Chat multimedia (LOPDP):** aviso de privacidad sobre grabaciones de voz e imágenes de terceros, plazo de 30 días, uso como prueba en reportes y entrega a autoridades solo con orden.
6. **Sanciones:** reglamento interno con debido proceso (derecho a ser escuchado, apelación) revisado por un abogado laboral/civil.
7. **Modo Ella y Conductor Aliado:** revisar que el filtro por conductoras no se considere discriminación según la normativa ecuatoriana y redactar el texto con asesoría de organizaciones LGBTI de Guayaquil.
8. **Inti Puntos:** términos y condiciones (vencimiento, no son dinero, cambios del programa).
9. **Pentest** de los flujos nuevos (subida de archivos, reportes, ofertas) antes del lanzamiento: ningún sistema es "imposible de hackear"; lo que se hace es reducir el riesgo y detectar rápido.

## 5. Variables nuevas (`.env.example`)

`SURGE_ENABLED`, `SURGE_MAX`, `REASSIGN_ARRIVED_COMPENSATION_CENTS`, `SAFETY_CHECK_RESPONSE_SECONDS`, `DEVIATION_THRESHOLD_M`, `DEVIATION_MIN_TRIP_SECONDS`, `LONG_STOP_SECONDS`, `SAFETY_SWEEP_MS`, `SOS_INTERNAL_URL`. Se eliminó `PLATFORM_COMMISSION_BPS` (ahora en la base de datos, editable desde el panel).

## 6. Siguiente paso

- App de conductor (Android): ofertas con preferencias y calificación del pasajero, chat, calificar al pasajero, Taxi Ruta/furgoneta, grúa y alquiler, curso Aliado.
- En el panel web: pantallas para Confianza y Seguridad (reportes), comisiones, aprobación de conductoras y proveedores de grúa/alquiler (las APIs ya existen).
- Pagos con tarjeta para grúa y alquiler (fase 2).
