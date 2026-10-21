# Inti Taxi — Descripción completa de la app (estado al 2026-10-21)

Usa este texto como "prompt" o especificación para describir, presentar o seguir construyendo la app.

---

## 1. Qué es

**Inti Taxi** es una app de movilidad para **Guayaquil, Ecuador**: todo usa la hora de Guayaquil (America/Guayaquil). Su prioridad es la **seguridad**: todas las personas que viajan quedan registradas, los conductores y socios están verificados con cédula y biometría, y la integración con el **ECU 911** se usa solo en emergencias reales.

Es **una sola app Android** (`ec.intitaxi.app`) para **viajar** y para **trabajar**, con un selector **Viajar | Trabajar** en la parte superior. Además tiene:
- un **panel web de administración**, para el equipo de Inti Taxi;
- un **simulador**, para hacer pruebas sin teléfonos ni datos reales.

**Diseño:** negro profundo y dorado, títulos con letra serifa, tarjetas redondeadas, barra de pestañas con íconos y una franja arcoíris discreta para Modo Ellxs.

---

## 2. Registro e inicio de sesión

- **Entrar con el celular:** código de 6 dígitos por SMS. La pantalla del código no permite capturas.
- **Entrar con passkey:** huella o rostro, sin SMS. Resiste el robo de la SIM y el phishing.
- La sesión dura gracias a un token renovable, guardado cifrado y **ligado al teléfono**: si se copia a otro teléfono, no funciona. El acceso se renueva cada 10 minutos sin que el usuario lo note.
- Al entrar por primera vez aparece **"¿Cómo quieres usar Inti Taxi?"**:
  - **Quiero viajar** (usuario normal).
  - **Quiero trabajar como:**
    - nuevo conductor de taxi;
    - dueño de taxi amarillo (Taxi Ruta);
    - dueño de furgoneta (Taxi Ruta);
    - empresa de alquiler de autos;
    - operador de grúa.
- Se puede cambiar de modo cuando se quiera, sin volver a iniciar sesión.

### Verificación de identidad (KYC)

- Foto de la **cédula** y **selfie con prueba de vida**, hecha por un proveedor especializado.
- Antes se acepta un **consentimiento explícito** para datos biométricos.
- La app de Inti Taxi no guarda fotos del rostro.
- Una cédula ya usada en otra cuenta pasa a **revisión manual** (prevención de fraude).

---

## 3. Modo VIAJAR (usuario)

### 3.1 Inicio
- Mapa con la ubicación actual, saludo con el nombre elegido y la pregunta **"¿A dónde vamos?"** con un buscador de destino.
- Botones de servicios:

  | Botón | Qué es |
  |---|---|
  | **Taxi** | A demanda |
  | **Taxi Ruta** | Precio por persona |
  | **Furgoneta** | Rutas fijas |
  | **Grúa** | El usuario hace su oferta |
  | **Alquiler** | El usuario hace su oferta |
  | **Ellxs** | Para mujeres y personas LGBTI |

- Preferencias rápidas que se activan con un toque: 🤫 Silencio · ❄ A/C · 🧳 Equipaje · 🐾 Mascota · ♿ Accesible.
- Saldo de **Inti Puntos** y estado de la **alerta de desvío**.
- Pestañas: **Inicio · Mis viajes · Cuenta**.
- Si la app se cerró durante un viaje, al abrirla retoma ese viaje.

### 3.2 Pedir taxi
1. **Origen:** "Mi ubicación" por GPS o un lugar de la lista. Si el GPS es simulado, se avisa y no se usa.
2. **Destino:** un lugar de la lista (Mall del Sol, Malecón, Mall del Río, etc.).
3. **Preferencias del viaje:** silencio, A/C, equipaje, mascota, silla de ruedas.
   - El conductor las ve antes de aceptar.
   - Mascota y silla de ruedas solo se asignan a vehículos preparados.
4. **Filtros:**
   - **Modo Ellxs:** solo conductorxs Ellxs. Solo aparece si la persona lo activó.
   - **Solo Conductores Aliados:** conductores con formación en inclusión LGBTI.
5. **¿Quiénes viajan?**
   - Cada acompañante se registra con nombre, cédula válida y correo. Los menores no necesitan correo.
   - Hasta 3 acompañantes en taxi.
   - Opción **"el taxi es para otra persona"**: se registran los datos y el celular de esa persona.
6. **Pago:**
   - Efectivo, tarjeta o billetera.
   - En teléfonos modificados o "rooteados", solo efectivo.
7. **Precio cerrado** antes de pedir, con distancia y tiempo.
   - Si hay **tarifa dinámica**, se muestra el desglose: tarifa base + extra (máximo 1,5 veces la base).
   - El motivo del extra es "alta demanda" o "pocos conductores".
   - **El 100 % del extra es para el conductor.**

### 3.3 Viaje en curso
- **Estados:** buscando conductor → va en camino → llegó → en viaje → terminado o cancelado.
- **Mapa en vivo** con la posición del taxi.
- **Perfil del conductor:**
  - nombre e insignia de identidad verificada;
  - estrellas y calificación;
  - número de viajes y año desde que conduce;
  - etiquetas positivas con su conteo (Amable, Puntual, Auto limpio…);
  - insignias 🤝 Aliado y 🌈 Ellxs;
  - vehículo y **placa** destacada.
- **PIN para subir:** 4 dígitos, en pantalla protegida contra capturas. Sin el PIN, el conductor no puede iniciar el viaje.
- **Chat con el conductor**, desde que se asigna hasta llegar al destino:
  - texto en tiempo real;
  - **notas de voz** de hasta 60 s;
  - **fotos**, desde la cámara o la galería;
  - **videos de hasta 20 s**.
  - El servidor revisa cada archivo: tipo real, duración, borra la ubicación de las fotos y busca malware.
  - Los archivos se abren solo al tocarlos, con un enlace que dura 60 s.
  - El chat se guarda 30 días, o más si hay un reporte o un SOS.
  - Los números de teléfono y correos escritos en el chat se ocultan.
- **Pedir otra unidad:** hasta **5 veces**; al sexto intento la carrera se cierra. Si el conductor ya había llegado, Inti Taxi le paga una compensación de $1 (el pasajero no paga nada).
- **Cancelar** el viaje.
- **Compartir el viaje en vivo** con un enlace temporal.
- **Botón SOS** (se mantiene presionado para evitar toques accidentales):
  - llama al **911**;
  - avisa al centro de monitoreo de Inti Taxi;
  - envía la ubicación cada 10 s;
  - se cancela con el PIN de seguridad;
  - si se usa el **PIN de coacción**, la alerta parece cancelada pero sigue activa en silencio.
- **Alerta de desvío y parada inesperada:**
  - Si el vehículo se aleja del destino o se detiene mucho tiempo, la app pregunta solo al pasajero: **"¿Estás bien?"**.
  - Si responde "Necesito ayuda" o no responde a tiempo, se activa el SOS automáticamente.
  - Por defecto funciona de noche (21:00–06:00); se puede poner "siempre" o apagarla.

### 3.4 Al terminar
- **Recibo** con el total, la forma de pago y las horas de inicio y fin.
- **Calificar al conductor** de 1 a 5 estrellas, con etiquetas:
  - si la calificación es de 4 o 5: Amable, Puntual, Auto limpio, Buena conducción, Conversación agradable, Ruta eficiente, Respetuoso;
  - si es de 1 a 3: Llegó tarde, Conducción brusca, Auto sucio, Ruta más larga, Trato irrespetuoso.
- **Reclamo** por el cobro, la ruta u objetos olvidados (hasta 30 días después del viaje).
- **Reportar malos tratos:**
  - categorías: malos tratos, discriminación, acoso, amenazas, conducción peligrosa u otro;
  - relato y, como pruebas, archivos del chat;
  - discriminación y acoso tienen prioridad alta;
  - un agente investiga, contacta al reportado y sanciona solo si hay pruebas;
  - los reportes falsos también se sancionan;
  - el estado se ve en **Mis reportes**.

### 3.5 Taxi Ruta (rutas fijas, cobro por persona)
- Lista de rutas activas con la tarifa vigente para **taxi** y para **furgoneta**, y si la ruta está **abierta o cerrada**.
- **Ruta 1:**
  - Horario: de **06:30 a 22:59**; desde las **23:00 la ruta se cierra**.
  - Tarifa por persona:

    | | Diurna (06:30–20:59) | Nocturna (21:00–22:59) |
    |---|---|---|
    | Taxi | $3,00 | $4,00 |
    | Furgoneta | $2,80 | $3,80 |

  - Paradas (ida): Villa Bonita → San Marino → Mall del Sol → City Mall → Riocentro Norte → Mall del Río → Parque Centenario → 9 de Octubre → Vélez → Chile y Colón → Bahía – Castillo. También tiene sentido de vuelta. Las coordenadas de las paradas están por verificar.
- **Cómo se reserva:**
  1. Elegir el sentido (ida o vuelta).
  2. Tocar la parada de subida y la de bajada.
  3. Ver los vehículos que aún no pasan por esa parada, con asientos libres, tiempo estimado de llegada y tarifa por persona.
  4. Filtrar por Todos / Taxi / Furgoneta.
  5. Reservar asientos registrando a cada acompañante (hasta 14 en furgoneta).
- **La tarifa se fija cuando el conductor confirma la subida con el PIN**, con la hora de Guayaquil de ese momento.
- **Reserva:**
  - perfil del conductor y PIN para subir;
  - **cambiar de unidad** hasta 5 veces;
  - cancelar;
  - chat y SOS;
  - recibo al final.
- Una reserva que no se usa caduca a los 45 minutos o al cerrar la ruta, y los asientos se liberan solos.

### 3.6 Grúa (el usuario oferta)
1. ¿Dónde está el vehículo? (GPS o un lugar) y ¿a dónde se lleva?
2. Tipo de vehículo: moto, auto, camioneta o pesado.
3. Problema: no enciende, choque, llanta, sin combustible u otro, más detalles. Si hay heridos, la app sugiere usar primero el SOS o llamar al 911.
4. **¿Cuánto quieres pagar?**
   - Botones −/+ y un **precio justo sugerido**.
   - La oferta puede ir de la mitad del mínimo sugerido a 3 veces el máximo.
   - Si la oferta es baja, la app avisa.
5. **La primera grúa verificada que acepta** se queda con el servicio.
6. Mientras se espera:
   - se puede **subir la oferta** o cancelar;
   - la oferta vence a los 15 minutos;
   - se ven el perfil del operador y la grúa en el mapa.
7. Se paga en efectivo al terminar y se califica al operador.

### 3.7 Alquiler de vehículo (el usuario oferta)
1. Categoría: auto, SUV, camioneta o furgoneta.
2. Fecha de inicio (hoy, mañana o los días siguientes) y número de días (1 a 30). Desde 7 días el precio sugerido baja un 10 %.
3. Lugar de entrega y notas.
4. Oferta con precio sugerido. **La primera empresa de alquiler que acepta** se queda con la solicitud.
5. La oferta vence a los 60 minutos.
6. **Requiere identidad verificada.** La empresa revisa la licencia del cliente y firma el contrato al entregar el vehículo.
7. Se puede subir la oferta, cancelar y calificar a la empresa.

### 3.8 Cuenta
- Datos del usuario: teléfono y correo (agregar y verificar).
- **Verificación de identidad.**
- **Trabajar con Inti Taxi**, que abre el menú de perfiles de socio.
- **Preferencias:**
  - Cómo quieres que te llamen: el conductor ve este nombre en lugar del de la cédula.
  - **Modo Ellxs:**
    - Interruptor "Soy mujer o parte de la comunidad LGBTI".
    - Para activarlo se lee y se acepta un consentimiento (es un dato sensible).
    - No se pregunta a qué grupo pertenece la persona y nunca se muestra al conductor.
    - Al desactivarlo, el dato se borra.
  - Alerta de desvío: de noche, siempre o apagada.
  - Preferencias de viaje por defecto.
- **Inti Puntos:**
  - Se gana 1 punto por cada dólar pagado.
  - **100 puntos equivalen a $1** de crédito en la billetera.
  - Se puede canjear desde 500 puntos, con un máximo de 2000 al mes.
  - Se ven los movimientos.
- **Mis reportes.**
- **Seguridad del viaje:** PIN de seguridad, PIN de coacción y contactos de confianza.
- **Billetera:** solo reembolsos y créditos promocionales; no se puede recargar.
- **Passkey:** crear una para entrar sin SMS.
- **Información del dispositivo:** dónde se guarda la clave (chip seguro StrongBox o entorno seguro TEE) y los riesgos detectados.
- **Cerrar sesión:** cierra la sesión de viajar y la de trabajar.

---

## 4. Modo TRABAJAR (socios)

Arriba se muestra el selector **Viajar | Trabajar** y el perfil del socio. Las pestañas son **Trabajo · Ganancias · Cuenta**.

### 4.1 Perfiles y requisitos

| Perfil | Datos que se piden | Documentos | Vehículo |
|---|---|---|---|
| Nuevo conductor de taxi | Licencia profesional (C, C1, D, D1, E, E1) y su vencimiento | Licencia, antecedentes penales | Taxi (1–4 asientos) |
| Dueño de taxi amarillo (Taxi Ruta) | Licencia | Licencia, antecedentes | Taxi |
| Dueño de furgoneta (Taxi Ruta) | Licencia | Licencia, antecedentes | Furgoneta (5–15 asientos) |
| Empresa de alquiler de autos | **Razón social y RUC** (no se pide licencia) | Certificado del RUC | Vehículos de alquiler (1–8 asientos y una categoría) |
| Operador de grúa | Licencia | Licencia, antecedentes | Grúa (1–2 asientos) |

- **Todos** deben tener la identidad verificada (cédula y selfie).
- **Cada vehículo** necesita matrícula y seguro vigente.
- Un revisor **confirma la cantidad de asientos** con la matrícula.

### 4.2 Proceso de alta
1. **Paso 1 – Tus datos:** verificación de identidad, y licencia o datos de la empresa.
2. **Paso 2 – Vehículo y documentos:**
   - Registrar el vehículo: placa ecuatoriana (ABC-1234), marca, modelo, año, color y asientos.
   - Subir la **foto de cada documento** con la cámara o desde la galería, con su fecha de vencimiento.
   - La app calcula la huella (SHA-256) del archivo y el servidor la compara y revisa el archivo.
3. **Paso 3 – Enviar a revisión.**
   - La app muestra el estado (por completar, en revisión, aprobado, rechazado o suspendido), qué falta y los motivos de rechazo de cada documento.
   - El aviso de aprobación llega por SMS.

### 4.3 Trabajar (perfil aprobado)
- **Conectarse:**
  - Se elige el vehículo y se toca "Conectarme".
  - La ubicación se comparte solo mientras el socio está conectado y con la app abierta.
  - Con una ubicación simulada no se puede conectar.
- **Ofertas de viaje** (conductores de taxi y dueños de taxi amarillo). Cada oferta muestra:
  - el precio y el extra dinámico (que es para el conductor);
  - la distancia hasta la recogida y la del viaje;
  - el número de personas y la forma de pago;
  - la calificación y los viajes del pasajero;
  - sus preferencias y si es un viaje Ellxs o solo para Aliados;
  - una cuenta regresiva: la oferta dura 15 segundos.
  - El socio puede **Aceptar** o **Rechazar**.
- **Viaje del conductor:**
  - Datos del pasajero: nombre elegido, verificado, estrellas, viajes y etiquetas.
  - Preferencias del pasajero y personas registradas.
  - **Navegar** con Google Maps.
  - **Chat** con voz, foto y video.
  - **"Llegué"** → pedir el **PIN** al pasajero → **Iniciar viaje** → **Terminar viaje**.
  - **Calificar al pasajero:**
    - si la calificación es de 4 o 5: Amable, Puntual, Respetuoso, Cuidó el auto;
    - si es de 1 a 3: Impuntual, Trato irrespetuoso, Dejó basura.
  - **Reportar al pasajero.**
- **Taxi Ruta** (dueños de taxi amarillo y de furgoneta):
  - Catálogo de rutas con su horario.
  - **Pedir habilitación** en una ruta con un vehículo. La operadora la aprueba o la rechaza con un motivo.
  - **Iniciar recorrido** (ida o vuelta) y ver los asientos ocupados.
  - Pasajeros por recoger: **confirmar la subida con el PIN**, y la app muestra la tarifa fijada.
  - Pasajeros a bordo: chat y "Bajó".
  - **Terminar recorrido.**
- **Pedidos de grúa** (operadores conectados con su grúa):
  - Ofertas cercanas con el precio, si es una oferta justa o baja, el problema y las distancias.
  - Antes de aceptar solo se ve la **zona aproximada**.
  - **Aceptar:** el primero gana.
  - Pasos: Llegué → Iniciar servicio → Terminar.
  - Se cobra en efectivo.
- **Solicitudes de alquiler** (empresas): ofertas para sus categorías de vehículo, aceptar y pasos de entrega.
- **Ganancias:**
  - Saldo disponible y lo cobrado hoy.
  - Últimos viajes, con efectivo o pago en la app.
  - Retiros a una cuenta bancaria a nombre del propio socio, confirmados con passkey.
  - Si el saldo es negativo, se debe a comisiones de viajes cobrados en efectivo.
- **Cuenta del socio:**
  - **Curso Conductor Aliado:** lecciones y evaluación de 3 preguntas; al aprobarlo se obtiene la insignia 🤝.
  - **Conductorx Ellxs:** solicitud que aprueba un revisor.
  - Agregar vehículo, cambiar de perfil de socio, volver a modo Viajar y cerrar sesión.
- **Teléfonos modificados o "rooteados":** se puede viajar, pero **no trabajar**.

### 4.4 Comisiones de Inti Taxi

| Servicio | Comisión |
|---|---|
| Viajes a demanda | **9 % de la tarifa base**; el extra dinámico es 100 % del conductor |
| **Taxi Ruta** | **$0,90 por recorrido de taxi** y **$2,50 por recorrido de furgoneta**, una vez por recorrido terminado con pasajeros |
| Grúa y alquiler | **9 %** |

Todas las comisiones se pueden cambiar en el panel, dentro de límites máximos.

### 4.5 Sanciones
- Tras un reporte comprobado: **suspensión de 1 a 30 días** o **expulsión**. La expulsión necesita la aprobación de una segunda persona.
- Mientras dura la sanción, la persona no puede pedir viajes ni conectarse.
- Se avisa por SMS y la sanción se puede revocar.

---

## 5. Panel de administración (equipo de Inti Taxi)

- **Acceso:**
  - Solo con passkey.
  - Sin contraseñas y sin nada guardado en el navegador.
  - Sesión de 8 horas.
  - Las acciones de escritura exigen una passkey reciente.
- **Roles y qué hace cada uno:**

  | Rol | Qué hace |
  |---|---|
  | Revisión de conductores | Revisa documentos (enlace de 60 s y con motivo); confirma asientos; aprueba, rechaza o suspende socios; aprueba conductorxs Ellxs |
  | Gestión de rutas | Crea y edita rutas, paradas, tarifas por tipo de vehículo, **horario de servicio** y frecuencias; valida el orden de las paradas con mapas; publica con cuatro ojos; habilita conductores y **decide solicitudes de habilitación** |
  | Soporte | Reclamos y reembolsos; manifiesto del viaje (con motivo) |
  | Operador SOS | Centro de monitoreo de incidentes; enlace para la autoridad con un segundo aprobador |
  | Fraude | Señales de fraude; cédulas duplicadas |
  | Confianza y Seguridad | Reportes de malos tratos: asignar, registrar el contacto con el reportado, decidir y sancionar |
  | Auditor | Bitácora de auditoría (no se puede alterar) y verificación de su cadena |
  | Protección de datos | Solicitudes de los titulares de datos (acceso, borrado), respetando la retención legal |
  | Super administrador | Roles y comisiones |

- **Métricas** agregadas, sin datos personales.

---

## 6. Simulador (solo para pruebas)

- Crea pasajeros, conductores y administradores de prueba.
- Tiene una **Bandeja** donde llegan los SMS y correos simulados.
- Aprueba la verificación de identidad y los documentos.
- Mueve conductores por el mapa automáticamente.
- Ejecuta los flujos de viajes, Taxi Ruta, SOS, pagos, grúas y alquiler sin teléfonos reales.

---

## 7. Seguridad y privacidad (resumen)

- **Cada petición se firma** con una clave del chip seguro del teléfono (DPoP). Los tokens robados no sirven en otro teléfono.
- **Play Integrity** comprueba que la app es la original. Se detectan root, depuradores, Frida o Xposed, emuladores y ubicación simulada.
- **Datos sensibles cifrados** campo por campo: cédulas, licencias, RUC, nombres, chats y direcciones.
- **Bitácora de auditoría encadenada** que no se puede alterar.
- **Retención de datos:**
  - manifiesto de pasajeros: 180 días;
  - chat y archivos: 30 días, salvo que haya un reporte o un SOS.
- **Ellxs y orientación:**
  - Nunca se pregunta la orientación sexual ni la identidad de género.
  - Ellxs es una autodeclaración que la persona puede retirar.
- **ECU 911** solo ante emergencias reales; el envío de datos a autoridades requiere base legal y un segundo aprobador.
- En producción: HTTPS con *certificate pinning*, servidores en la nube y llaves en KMS.

## 8. Pendiente / siguientes pasos

- **Ubicación en segundo plano** para que el socio trabaje con la pantalla apagada (requiere una declaración en Google Play).
- Pantallas del panel para la aprobación de Ellxs y las comisiones (por ahora se hacen desde el simulador y la API).
- **Proveedores reales:** SMS, verificación de identidad, pagos, mapas y el convenio con el ECU 911.
- Coordenadas reales de las paradas de la Ruta 1.
- Pagos con tarjeta para grúa y alquiler.
- **Revisiones:** revisión legal y una prueba de penetración externa antes del lanzamiento.
