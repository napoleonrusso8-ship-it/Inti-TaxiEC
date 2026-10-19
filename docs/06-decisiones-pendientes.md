# 06 — Decisiones y revisiones requeridas

## 0. Decisiones aprobadas (2026-10-19)

| # | Decisión aprobada |
|---|---|
| D1 | Nombre: **Inti Taxi** (paquetes `@intitaxi/*`, bundle IDs `ec.intitaxi.passenger` / `ec.intitaxi.driver`) |
| D2–D12, D17 | Se adoptan las recomendaciones de este documento ("a tu mejor criterio") |
| D13 | Retención del manifiesto: **180 días** |
| D14 | Taxi Ruta: la tarifa se fija en el **momento en que se confirma el abordaje** (el conductor valida el PIN). Ejemplo: si se sube a las 21:00, paga $4.00. Para no sorprender al pasajero, la app muestra la tarifa como *estimada* y avisa cuando la reserva está a menos de 30 min de un cambio de franja |
| D11 | Billetera **sin recargas** en la fase 1 |
| D15 | **PIN de coacción**: sí |
| D16 | Audio: solo el dispositivo del activador, con consentimiento previo |
| Ruta 1 | El orden de paradas de la especificación **es el recorrido real** del taxi ruta (confirmado por el propietario). Mall del Río existe en Guayaquil. La validación con la API de mapas se usará solo para obtener coordenadas y la polilínea y para advertir de errores al crear **nuevas** rutas, no para reordenar la Ruta 1 |
| ECU 911 | La colaboración con ECU 911 se limita a **emergencias reales** (p. ej. accidentes): el valor que aportamos es el registro de quién viajaba en el vehículo. No hay intercambio rutinario de datos. Ver §0.1 |

### 0.1 Alcance de la integración ECU 911 (interpretación aprobada)
- Se envían datos a ECU 911 **solo** cuando existe un incidente de emergencia: un SOS confirmado o un **reporte de accidente** (el conductor o el centro de monitoreo lo pueden registrar aunque nadie pulse el SOS, p. ej. si los ocupantes no pueden).
- Lo que se entrega es el manifiesto (quién iba en el vehículo, conductor, placa) y la ubicación, para facilitar la atención y la identificación de los afectados.
- La llamada al 911 desde el teléfono **siempre** se inicia al pulsar el SOS, haya o no convenio.
- Fuera de una emergencia, solo se entregan datos ante un requerimiento legal válido.

---

> Las secciones siguientes son el análisis original con el que se tomaron estas decisiones.

## 1. Decisiones de stack y producto

| # | Decisión | Recomendación | Compromiso | Bloquea |
|---|---|---|---|---|
| D1 | Nombre de la app (`Inti Taxi`) y del repositorio | — | — | Módulo 1 (bundle IDs, dominio OIDC) |
| D2 | Móvil: React Native vs Flutter | **React Native** | RN: un solo lenguaje y validadores compartidos. Flutter: mejor ofuscación y rendimiento, pero un segundo lenguaje | Módulo 1 |
| D3 | Una app o dos (pasajero / conductor) | **Dos apps** | Más trabajo de publicación, pero menos superficie de ataque y permisos más limpios (el pasajero no necesita ubicación en segundo plano) | Módulo 1 |
| D4 | Backend: NestJS vs Go | **NestJS** (extraer `realtime` a Go más adelante si hace falta) | Go: menor costo de cómputo; NestJS: más velocidad de desarrollo | Módulo 1 |
| D5 | Servidor OIDC: `node-oidc-provider` vs Keycloak vs Cognito | **node-oidc-provider** | Más código propio que mantener y auditar frente a Keycloak (más pesado de operar) o Cognito (menos control de DPoP, rotación y passkeys) | Módulo 1 |
| D6 | Nube y región | **AWS `us-east-1`** + DR `us-west-2` | `sa-east-1` (São Paulo) tiene peor latencia a GYE y es ~30 % más cara; ninguna está en Ecuador → transferencia internacional (revisión legal) | Infra |
| D7 | Mapas: Google vs Mapbox | **Google Maps** | Mejor cobertura y Roads API (anti GPS falso) frente a un costo un 40-60 % mayor | Módulos 4, 6 y 9 |
| D8 | Proveedor KYC | **Veriff** (alternativa: Onfido) | Precio por verificación (~USD 1-2, a confirmar) frente a la calidad de la detección de inyección | Módulo 2 |
| D9 | Re-verificación del conductor: frecuencia | **Aleatoria ~1 de cada 5 conexiones + siempre ante señales de riesgo**, máximo 1 por día | Más frecuencia = más seguridad, más costo por verificación y más fricción | Módulo 2 |
| D10 | Pasarela de pagos | **Kushki** (alternativa: Payphone) | Comisiones y tiempos de liquidación por comparar | Módulo 7 |
| D11 | Billetera interna con recargas | **Fase 1: billetera solo para reembolsos/créditos promocionales, sin recargas**; recargas tras la revisión legal | Menor riesgo regulatorio frente a una función menos completa al lanzar | Módulo 7 |
| D12 | RASP: comercial vs freeRASP | **freeRASP en MVP → comercial (DexGuard/iXGuard) antes del lanzamiento público** | Costo de licencia (miles de USD/año) frente a la resistencia real a Frida | Módulo 1 (base) |
| D13 | Plazo de retención del manifiesto ([X] de la especificación) | **180 días** | Más plazo = más utilidad para investigaciones y más exposición ante una brecha | Módulos 5 y 8 |
| D14 | Hora de referencia de la tarifa de Taxi Ruta | **Hora de confirmación de la reserva** (el precio mostrado = el precio cobrado) | La especificación dice "hora de inicio del viaje": si se usa el abordaje real, alguien que reserva a las 20:55 y sube a las 21:05 pagaría $4 en lugar de los $3 mostrados | Módulo 9 |
| D15 | PIN de coacción en la cancelación del SOS | **Sí**: un PIN alternativo que "cancela" en pantalla pero mantiene la alerta | Más seguridad frente a una UX algo más compleja; requiere protocolo con el centro de monitoreo | Módulo 8 |
| D16 | Grabación de audio en SOS | **Solo audio del dispositivo del activador, con consentimiento previo, cifrado y 90 días** | Valor probatorio frente a la privacidad del resto de ocupantes (revisión legal) | Módulo 8 |
| D17 | Monolito modular frente a microservicios | **Monolito modular + `realtime`, `sos`, `ecu911-adapter` y `workers` separados** | Ver el §5 de la arquitectura | Módulo 1 |

## 2. Taxi Ruta — verificación preliminar del orden de paradas

La especificación pide verificar el orden con la API de mapas. Esa validación automática se implementará en el módulo 9 (`POST /v1/admin/routes/{id}/validate`, que usa Directions API y proyecta cada parada sobre la polilínea para comparar `seq` contra la distancia recorrida). **Todavía no he consultado ninguna API de mapas**; lo siguiente es una observación preliminar basada en conocimiento general de Guayaquil y **debe confirmarse**:

- Viniendo desde Villa Bonita por Vía a Daule → Narcisa de Jesús → Francisco de Orellana, lo habitual es encontrar primero **City Mall** y **Riocentro Norte** (sector norte, cerca de Narcisa de Jesús/Orellana) y después **San Marino** (Orellana, Kennedy) y **Mall del Sol** (Juan Tanca Marenco). En la lista, San Marino y Mall del Sol aparecen **antes** que City Mall y Riocentro Norte, lo que sugiere que el orden no sigue el recorrido.
- **Mall del Río** es un centro comercial conocido en Cuenca; en Guayaquil hay que confirmar a qué punto exacto se refiere (¿otro centro comercial o una referencia local?) y sus coordenadas.
- En el Centro, Parque Centenario y 9 de Octubre están sobre la Av. 9 de Octubre; Vélez y Chile y Colón quedan al sur, hacia la Bahía. Ese tramo parece coherente para el sentido Villa Bonita → Centro.

**Propuesta preliminar de orden (sentido Villa Bonita → Centro), por confirmar con la API:**
1. Villa Bonita (origen) · 2. City Mall · 3. Riocentro Norte · 4. San Marino · 5. Mall del Sol · 6. Mall del Río (ubicación por confirmar) · 7. Parque Centenario · 8. 9 de Octubre · 9. Vélez · 10. Chile y Colón · 11. Bahía – Castillo.

El sentido Centro → Villa Bonita usará el orden inverso, **salvo que** haya calles de un solo sentido en el Centro (muy probable). En ese caso se definirá una polilínea y unas paradas distintas para la vuelta (el modelo `route_directions` ya lo permite). **Necesito que confirmes el recorrido real, o que lo confirme el operador de la ruta.**

## 3. Partes que requieren revisión legal o auditoría humana

| Área | Qué revisar | Quién |
|---|---|---|
| **Biometría (LOPDP art. 26: dato sensible)** | Texto del consentimiento; evaluación de impacto (EIPD/DPIA); contrato de encargado (DPA) con el proveedor KYC; transferencia internacional (arts. 55-61); plazos de retención en el proveedor | Abogado en protección de datos + DPO |
| **Datos de terceros, acompañantes y menores** | Base legal (¿consentimiento o interés vital/legítimo?); texto del aviso; tratamiento de menores (representación legal); posibilidad de que viajen menores no acompañados | Abogado + DPO |
| **Convenio ECU 911** | Firma del convenio con el Servicio Integrado de Seguridad ECU 911; especificación técnica del canal; protocolo de SOS falsos; base legal para compartir el manifiesto | Dirección + abogado + ECU 911 |
| **Entrega de datos a autoridades** | Procedimiento de requerimientos judiciales/fiscales; quién aprueba | Abogado + DPO |
| **Pagos y billetera** | Alcance PCI DSS (SAQ A); regulación de la billetera (dinero electrónico); facturación electrónica SRI; retención tributaria de conductores | Abogado financiero/tributario + QSA |
| **Grabación de audio** | Consentimiento de todos los ocupantes; uso como prueba | Abogado |
| **Antecedentes penales de conductores** | Base legal y forma de obtención (certificado del Ministerio del Interior aportado por el conductor) | Abogado laboral |
| **Regulación de transporte** | Habilitación como plataforma/operadora (ANT, Agencia de Tránsito y Movilidad de Guayaquil — ATM); Taxi Ruta podría requerir un permiso de operación de transporte comercial o de rutas | Abogado regulatorio |
| **Auditorías técnicas** | Pentest externo antes del lanzamiento; revisión de código de `auth`, `kyc`, `payments` y `sos`; revisión del modelo de amenazas | Firma externa + equipo de seguridad |
| **Notificación de brechas** | Runbook alineado con los plazos de la LOPDP y la Superintendencia de Protección de Datos | DPO + abogado |
