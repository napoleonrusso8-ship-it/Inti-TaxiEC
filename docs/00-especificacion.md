# Especificación del proyecto: Inti Taxi

> **Documento de referencia.** Se consulta antes de cada módulo. Cualquier desviación requiere aprobación explícita del propietario del producto.
> Versión 1.0 — 2026-10-19

Rol: arquitecto de software senior y experto en ciberseguridad (OWASP, ISO 27001, PCI DSS). Aplicación de transporte bajo demanda tipo Uber, con verificación de identidad biométrica (estilo Airbnb), registro de todas las personas que viajan, integración con ECU 911 y servicio de rutas fijas ("Taxi Ruta"). **La seguridad es requisito principal en cada decisión.**

## 1. Contexto
- País: Ecuador (ciudad inicial Guayaquil). Cumplir la LOPDP de Ecuador y, como referencia, el GDPR.
- Zona horaria: `America/Guayaquil` (UTC-05:00).
- Usuarios: pasajeros, conductores, administradores.
- Plataformas: app móvil iOS/Android, panel web de administración, backend en la nube.

## 2. Funcionalidades principales
**Pasajero:** registro con teléfono (OTP SMS) y correo; solicitud de viaje con origen/destino en mapa y tarifa estimada; seguimiento en tiempo real, chat y llamada enmascarada; pagos con tarjeta tokenizada, efectivo y billetera; calificaciones, historial y recibos; SOS, compartir viaje en vivo y PIN de verificación; acompañantes y viajes para terceros (§5); pestaña Taxi Ruta (§7).

**Conductor:** onboarding con documentos (licencia, matrícula, SOAT/seguro, antecedentes) revisados por admin; aceptar/rechazar viajes, navegación, ganancias y retiros; re-verificación biométrica aleatoria (selfie en vivo) antes de conectarse; habilitación por ruta para Taxi Ruta.

**Administrador:** aprobación de conductores, disputas, fraude, auditoría y métricas; gestión de rutas/paradas/horarios/tarifas de Taxi Ruta; centro de monitoreo SOS; RBAC con mínimo privilegio y MFA obligatorio.

## 3. Verificación de identidad biométrica
- Documento (cédula/pasaporte) + selfie con prueba de vida + comparación facial 1:1.
- Proveedor KYC certificado (Veriff, Onfido, Jumio, Persona…), con justificación.
- No almacenar imágenes faciales ni plantillas biométricas salvo estricta necesidad; guardar resultado, referencia del proveedor y fecha.
- Si se almacena biometría: cifrado con KMS/HSM, acceso auditado, retención y borrado definidos.
- Consentimiento explícito, separado y revocable, con finalidad, plazo y derechos.
- Login rápido con biometría del dispositivo (Keychain/Keystore); la biometría nunca sale del teléfono.
- Detección de ataques de presentación (fotos, máscaras, deepfakes, cámara virtual).

## 4. Seguridad (obligatorio)
- **Autenticación:** OAuth 2.1/OIDC, access tokens cortos, refresh tokens rotativos; passkeys preferentes; MFA para operaciones sensibles; bloqueo progresivo, rate limiting, protección contra SIM swapping.
- **Móvil (MASVS L2 + R):** certificate pinning, detección root/jailbreak/emulador/hooking (Frida), ofuscación, sin secretos embebidos, solo Keychain/Keystore, nada sensible en logs/capturas, Play Integrity y App Attest, detección de GPS falso.
- **Backend/API (OWASP API Top 10):** autorización a nivel de objeto en cada endpoint, validación estricta, consultas parametrizadas, cabeceras de seguridad, API Gateway con WAF/rate limiting/DDoS, zero trust, mTLS, redes privadas.
- **Datos:** TLS 1.3, AES-256 en reposo, cifrado a nivel de campo (incl. cédula), Vault/KMS con rotación, minimización, seudonimización de ubicaciones históricas, retención, backups cifrados y probados en otra región.
- **Pagos:** nunca tocar datos de tarjeta; pasarela PCI DSS con tokenización y 3-D Secure; antifraude (velocidad, huella de dispositivo, viajes falsos, colusión).
- **Operación:** logs de auditoría inmutables, SIEM, alertas; CI/CD con SAST, DAST, SCA, escaneo de secretos y contenedores; IaC revisada; IAM mínimo privilegio; plan de respuesta a incidentes y notificación de brechas (LOPDP); pentest externo y bug bounty.

## 5. Acompañantes y viajes para terceros
- **5.1** Número de personas y registro de cada acompañante (nombres, cédula/pasaporte, correo). Validar cédula (módulo 10) y correo; Registro Civil/DINARDAP si hay convenio. Menores sin correo, vinculados a adulto responsable. Contactos frecuentes solo con consentimiento. No superar la capacidad del vehículo.
- **5.2** Viaje para un tercero (nombres, cédula, correo, teléfono). El tercero recibe datos del conductor, placa, PIN y enlace de seguimiento sin app. El solicitante ve el seguimiento y recibe aviso de llegada. Roles "solicitante" y "pasajero(s)".
- **5.3** Notificación LOPDP a cada persona registrada con finalidad y enlace para confirmar/consultar/eliminar. Cédula enmascarada (`09******23`). Retención del manifiesto de [X] días/meses y borrado automático salvo incidente o requerimiento legal. Auditoría de cada acceso (quién, cuándo, por qué).

## 6. Manifiesto e integración ECU 911
- Manifiesto inmutable por viaje: solicitante, pasajeros, acompañantes, conductor (con su verificación biométrica más reciente), vehículo/placa, inicio/fin, ruta GPS completa.
- SOS para pasajeros, acompañantes con enlace y conductor: (1) llamada al 911 desde el teléfono; (2) envío a ECU 911 del manifiesto y ubicación en tiempo real; (3) aviso a contactos de confianza y monitoreo interno; (4) grabación de audio si fue autorizada y marca de "incidente" con conservación de datos.
- Adaptador ECU 911 independiente. Sin convenio: llamada directa al 911 + enlace seguro, temporal y firmado con el manifiesto que el monitoreo interno entrega a las autoridades.
- Solo por mTLS, autenticado y auditado. Nada se comparte fuera de emergencia o requerimiento legal válido.
- Simulación de SOS en pruebas sin contactar al 911 real.

## 7. Taxi Ruta
**Ruta 1: Villa Bonita – Centro (Guayaquil).** Vías: Vía a Daule → Autopista Narcisa de Jesús → Av. Francisco de Orellana → Av. Juan Tanca Marenco → Av. de las Américas.
Paradas: San Marino, Mall del Sol, City Mall, Riocentro Norte, Mall del Río, Parque Centenario, 9 de Octubre, Vélez, Chile y Colón, Bahía – Castillo.
Tarifa por persona: **$3.00** de 06:30 a 20:59; **$4.00** de 21:00 a 06:29 (nocturna). Se calcula con la hora de inicio del viaje en `America/Guayaquil`.

Requisitos: ruta y paradas en el mapa (verificar orden con la API de mapas y proponer correcciones); elegir parada de subida/bajada y asientos (acompañantes según §5.1); vehículos en tiempo real, asientos libres y ETA; ambos sentidos; pago por persona y recibo con tarifa aplicada; conductores habilitados por ruta; rutas/paradas/horarios/tarifas configurables sin cambiar código; mismo manifiesto y SOS de §6.

## 8. Stack sugerido (ajustable con justificación)
Móvil React Native/Flutter; backend NestJS/Go/Kotlin; PostgreSQL + PostGIS; Redis; WebSockets o MQTT; Google Maps/Mapbox; AWS/GCP/Azure.

## 9. Forma de trabajo
1. Primero: arquitectura (Mermaid), estructura del monorepo, modelo de datos, STRIDE y endpoints en `docs/`; esperar aprobación.
2. Módulos en orden: (1) Autenticación y sesiones; (2) Verificación biométrica; (3) Onboarding de conductores; (4) Solicitud y emparejamiento; (5) Acompañantes y terceros; (6) Tiempo real; (7) Pagos; (8) PIN, SOS, manifiesto y adaptador ECU 911; (9) Taxi Ruta; (10) Panel de administración.
3. Cada módulo: código, pruebas unitarias y de integración, sección "Riesgos de seguridad y cómo se mitigan", y commit descriptivo.
4. Sin datos ni claves reales; `.env.example` y datos de prueba; nunca subir secretos.
5. Compromisos seguridad/costo/UX: explicar y preguntar antes de elegir.
6. Señalar lo que requiere revisión legal o auditoría humana (biometría, datos de terceros, convenio ECU 911, pagos).
7. Al terminar cada módulo: qué se hizo, qué falta y siguiente paso.
