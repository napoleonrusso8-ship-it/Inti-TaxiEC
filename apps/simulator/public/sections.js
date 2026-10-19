// Acciones del simulador por módulo. Cada módulo nuevo agrega su sección aquí.
const phoneDefault = (d) => d.phone ?? '';
const MOBILE = ['passenger', 'driver'];
const firstDriver = (_d, s) => s.devices.find((x) => x.role === 'driver' && x.userId)?.userId ?? '';
const driverId = { name: 'driverId', label: 'ID del conductor (usuario)', default: firstDriver };
const PLACE_NAMES = ['Mall del Sol', 'Malecón 2000', 'Aeropuerto José Joaquín de Olmedo', 'Terminal Terrestre', 'Parque Centenario', 'City Mall', 'Riocentro Norte', 'San Marino', 'Urdesa', 'Samborondón'];
const place = (name, label, first = 0) => ({ name, label, type: 'select', options: [...PLACE_NAMES.slice(first), ...PLACE_NAMES.slice(0, first)].map((p) => ({ value: p, label: p })) });

export const SECTIONS = [
  {
    title: 'Módulo 1 · Registro e inicio de sesión',
    roles: MOBILE,
    items: [
      { label: 'Pedir código SMS', action: 'otp.request', hint: 'Celular ecuatoriano (09…). El SMS aparece en la Bandeja.', fields: [{ name: 'phone', label: 'Celular', placeholder: '0991234567', default: phoneDefault }] },
      { label: 'Verificar código', action: 'otp.verify', hint: 'Registra o inicia sesión. Máx. 5 intentos.', fields: [{ name: 'code', label: 'Código', source: 'otp' }] },
      { label: 'Ver mi perfil', action: 'me', hint: 'Los datos vuelven enmascarados.' },
      { label: 'Renovar sesión (refresh)', action: 'refresh', hint: 'Rota el refresh token.' },
      { label: 'Olvidar token de acceso', action: 'token.forget', hint: 'Simula que pasaron 10 min; luego usa "Renovar".' },
      { label: 'Mis sesiones', action: 'sessions' },
      { label: 'Cerrar una sesión', action: 'session.revoke', fields: [{ name: 'sessionId', label: 'ID de sesión' }] },
      { label: 'Cerrar sesión (logout)', action: 'logout' },
    ],
  },
  {
    title: 'Módulo 1 · Correo, passkeys y biometría',
    roles: MOBILE,
    items: [
      { label: 'Registrar correo', action: 'email.set', fields: [{ name: 'email', label: 'Correo', placeholder: 'ana@correo.ec' }] },
      { label: 'Abrir enlace de verificación', action: 'email.verify', fields: [{ name: 'token', label: 'Token del enlace', source: 'email-link' }] },
      { label: 'Crear passkey', action: 'passkey.register', hint: 'Autenticador WebAuthn por software (UV obligatoria).' },
      { label: 'Iniciar sesión con passkey', action: 'passkey.login', hint: 'Usa la passkey de otro dispositivo (sincronizada).', fields: [{ name: 'fromDevice', label: 'ID del dispositivo con la passkey', default: (d, s) => s.devices.find((x) => x.hasPasskey)?.id ?? '' }] },
      { label: 'Activar Face ID / huella', action: 'devicekey.register', hint: 'Clave en el chip seguro; la biometría no sale del teléfono.' },
      { label: 'Entrar con Face ID / huella', action: 'devicekey.login' },
    ],
  },
  {
    title: 'Módulo 1 · Operaciones sensibles (step-up y SIM swap)',
    roles: MOBILE,
    items: [
      { label: 'Confirmar con passkey', action: 'stepup.passkey', hint: 'Da acr=phr y levanta el bloqueo anti SIM swap.' },
      { label: 'Confirmar con correo + Face ID (1/2)', action: 'stepup.email.options', hint: 'Envía un código al correo verificado.' },
      { label: 'Confirmar con correo + Face ID (2/2)', action: 'stepup.email.verify', fields: [{ name: 'code', label: 'Código del correo', source: 'otp-email' }] },
      { label: 'Cambiar número (1/2)', action: 'phone.change', hint: 'Exige confirmación reciente.', fields: [{ name: 'phone', label: 'Número nuevo' }] },
      { label: 'Cambiar número (2/2)', action: 'phone.confirm', fields: [{ name: 'code', label: 'Código SMS', source: 'otp' }] },
    ],
  },
  {
    title: 'Módulo 2 · Verificación biométrica (proveedor simulado tipo Veriff)',
    roles: MOBILE,
    note: 'La app real abre el SDK del proveedor (documento + selfie con prueba de vida). Aquí tú haces de proveedor y eliges el resultado.',
    items: [
      { label: 'Leer consentimiento', action: 'consent.text', fields: [{ name: 'purpose', label: 'Finalidad', type: 'select', options: [{ value: 'biometric_kyc', label: 'Verificación biométrica' }, { value: 'audio_recording', label: 'Audio en emergencias' }, { value: 'trip_sharing', label: 'Compartir viajes' }, { value: 'companion_data', label: 'Datos de acompañante' }] }] },
      { label: 'Aceptar consentimiento', action: 'consent.grant', hint: 'Separado, explícito y revocable.', fields: [{ name: 'purpose', label: 'Finalidad', type: 'select', options: [{ value: 'biometric_kyc', label: 'Verificación biométrica' }, { value: 'audio_recording', label: 'Audio en emergencias' }, { value: 'trip_sharing', label: 'Compartir viajes' }, { value: 'companion_data', label: 'Datos de acompañante' }] }] },
      { label: 'Revocar consentimiento', action: 'consent.revoke', hint: 'Invalida el resultado y borra los datos en el proveedor.', fields: [{ name: 'purpose', label: 'Finalidad', type: 'select', options: [{ value: 'biometric_kyc', label: 'Verificación biométrica' }, { value: 'audio_recording', label: 'Audio en emergencias' }, { value: 'trip_sharing', label: 'Compartir viajes' }, { value: 'companion_data', label: 'Datos de acompañante' }] }] },
      { label: 'Mis consentimientos', action: 'consents' },
      { label: 'Iniciar verificación', action: 'kyc.start', fields: [{ name: 'kind', label: 'Tipo', type: 'select', options: [{ value: 'full', label: 'Completa (cédula + selfie)' }, { value: 'driver_reverify', label: 'Selfie de conductor' }] }] },
      {
        label: 'Proveedor: decidir',
        action: 'kyc.decide',
        hint: 'Para la selfie del conductor, usa la MISMA cédula; otra simula una cuenta prestada.',
        fields: [
          { name: 'status', label: 'Resultado', type: 'select', options: [{ value: 'approved', label: 'Aprobado' }, { value: 'declined', label: 'Rechazado (prueba de vida falló)' }, { value: 'resubmission_requested', label: 'Repetir' }] },
          { name: 'documentNumber', label: 'Número de cédula', default: '0912345675' },
          { name: 'givenNames', label: 'Nombres', default: 'Ana María' },
          { name: 'familyNames', label: 'Apellidos', default: 'Pérez Loor' },
        ],
      },
      { label: 'Estado de mi verificación', action: 'kyc.status', hint: 'Sin imágenes; la cédula enmascarada.' },
      { label: 'Conductor: ¿selfie antes de conectarme?', action: 'reverify.check', roles: ['driver'] },
    ],
  },
  {
    title: 'Módulo 3 · Ser conductor (solicitud, vehículo y documentos)',
    roles: ['driver'],
    note: 'Requisito previo: identidad verificada (módulo 2).',
    items: [
      { label: 'Enviar datos de licencia', action: 'driver.apply', fields: [{ name: 'licenseNumber', label: 'Nº de licencia', default: 'L0912345675' }, { name: 'licenseCategory', label: 'Categoría', type: 'select', options: ['C', 'C1', 'D', 'E', 'B'].map((c) => ({ value: c, label: c === 'B' ? 'B (no profesional: se rechaza)' : c })) }, { name: 'licenseExpiresOn', label: 'Vence', default: '2029-12-31' }] },
      { label: 'Registrar vehículo', action: 'vehicle.add', fields: [{ name: 'plate', label: 'Placa', default: 'GSA-1234' }, { name: 'make', label: 'Marca', default: 'Chevrolet' }, { name: 'model', label: 'Modelo', default: 'Aveo' }, { name: 'year', label: 'Año', default: '2022' }, { name: 'color', label: 'Color', default: 'Amarillo' }, { name: 'seats', label: 'Asientos para pasajeros', default: '4' }] },
      {
        label: 'Subir documento',
        action: 'doc.upload',
        hint: 'Los de vehículo se asocian al último vehículo registrado.',
        fields: [
          { name: 'type', label: 'Documento', type: 'select', options: [{ value: 'license', label: 'Licencia' }, { value: 'background_check', label: 'Antecedentes (PDF)' }, { value: 'registration', label: 'Matrícula' }, { value: 'insurance', label: 'SOAT/SPPAT o seguro' }] },
          { name: 'variant', label: 'Archivo', type: 'select', options: [{ value: 'valid', label: 'Válido' }, { value: 'eicar', label: 'Con "malware" (EICAR)' }, { value: 'fake_type', label: 'PDF disfrazado de imagen' }, { value: 'pdf_js', label: 'PDF con JavaScript' }] },
          { name: 'expiresOn', label: 'Vence', default: '2030-01-01' },
        ],
      },
      { label: 'Enviar solicitud a revisión', action: 'driver.submit' },
      { label: 'Ver mi estado de conductor', action: 'driver.profile' },
    ],
  },
  {
    title: 'Módulo 4 · Pedir un taxi',
    roles: ['passenger'],
    items: [
      { label: 'Cotizar', action: 'trip.quote', hint: 'Precio cerrado, válido 5 min.', fields: [place('from', 'Origen'), place('to', 'Destino', 1)] },
      { label: 'Confirmar viaje', action: 'trip.request', fields: [{ name: 'paymentMethod', label: 'Pago', type: 'select', options: [{ value: 'cash', label: 'Efectivo' }, { value: 'card', label: 'Tarjeta' }, { value: 'wallet', label: 'Billetera' }] }] },
      { label: 'Ver mi viaje', action: 'trip.view', hint: 'Conductor, placa y ubicación.' },
      { label: 'Ver PIN', action: 'trip.pin', hint: 'Díselo al conductor al subir.' },
      { label: 'Llamar al conductor (número enmascarado)', action: 'trip.contact' },
      { label: 'Cancelar', action: 'trip.cancel', hint: 'No se puede una vez iniciado.' },
      { label: 'Calificar', action: 'trip.rate', fields: [{ name: 'stars', label: 'Estrellas', type: 'select', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: '★'.repeat(n) })) }, { name: 'comment', label: 'Comentario' }] },
      { label: 'Historial', action: 'trip.history' },
    ],
  },
  {
    title: 'Módulo 5 · Acompañantes y viajes para terceros',
    roles: ['passenger'],
    note: 'Primero "Cotizar" (módulo 4). Las cédulas de prueba se generan válidas (módulo 10).',
    items: [
      {
        label: 'Confirmar viaje con grupo',
        action: 'trip.request.group',
        fields: [
          { name: 'adults', label: 'Acompañantes adultos', type: 'select', options: [0, 1, 2, 3].map((n) => ({ value: n, label: String(n) })) },
          { name: 'minor', label: 'Con un menor', type: 'select', options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Sí' }] },
          { name: 'thirdParty', label: 'Es para otra persona', type: 'select', options: [{ value: 'false', label: 'No, viajo yo' }, { value: 'true', label: 'Sí (Carmen, sin app)' }] },
          { name: 'thirdPhone', label: 'Celular del tercero', default: '0987654321' },
          { name: 'badCedula', label: 'Probar cédula inválida', type: 'select', options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Sí' }] },
        ],
      },
      { label: 'Ver quiénes viajan', action: 'trip.parties', hint: 'Cédulas enmascaradas; el acceso se audita.' },
      { label: 'Guardar contacto frecuente', action: 'companion.save', hint: 'El acompañante debe confirmar por correo.', fields: [{ name: 'givenNames', label: 'Nombres', default: 'Sofía' }, { name: 'familyNames', label: 'Apellidos', default: 'Mendoza' }, { name: 'email', label: 'Correo', default: 'sofia@correo.test' }, { name: 'alias', label: 'Alias', default: 'Mi prima' }] },
      { label: 'Mis contactos frecuentes', action: 'companion.list' },
      { label: 'Titular: ver mis datos (enlace del correo)', action: 'subject.view', fields: [{ name: 'token', label: 'Token del enlace', source: 'subject-link' }] },
      { label: 'Titular: confirmar / dar consentimiento', action: 'subject.confirm', fields: [{ name: 'token', label: 'Token del enlace', source: 'subject-link' }] },
      { label: 'Titular: pedir eliminación', action: 'subject.delete', fields: [{ name: 'token', label: 'Token del enlace', source: 'subject-link' }] },
    ],
  },
  {
    title: 'Módulo 4 · Manejar',
    roles: ['driver'],
    note: 'Antes: conductor aprobado y, si toca, selfie de re-verificación (módulo 2).',
    items: [
      { label: 'Conectarme', action: 'driver.online', fields: [place('at', 'Estoy en')] },
      { label: 'Mover mi ubicación', action: 'driver.location', fields: [place('at', 'Ir a'), { name: 'mock', label: 'GPS falso', type: 'select', options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Sí (app de ubicación falsa)' }] }] },
      { label: 'Ver ofertas', action: 'driver.offers', hint: 'Cada oferta dura 15 s.' },
      { label: 'Aceptar oferta', action: 'driver.accept' },
      { label: 'Rechazar oferta', action: 'driver.reject' },
      { label: 'Llegué', action: 'driver.arrived' },
      { label: 'Iniciar con PIN', action: 'driver.start', hint: 'El PIN lo da el pasajero. 3 intentos.', fields: [{ name: 'pin', label: 'PIN' }] },
      { label: 'Finalizar viaje', action: 'driver.complete' },
      { label: 'Viaje actual', action: 'driver.current' },
      { label: 'Calificar pasajero', action: 'trip.rate', fields: [{ name: 'stars', label: 'Estrellas', type: 'select', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: '★'.repeat(n) })) }] },
      { label: 'Desconectarme', action: 'driver.offline' },
    ],
  },
  {
    title: 'Módulo 7 · Pagos',
    roles: ['passenger'],
    note: 'La tarjeta se tokeniza en la pasarela (aquí: simulada). Para pagar con tarjeta elige "Tarjeta" al confirmar el viaje.',
    items: [
      { label: 'Agregar tarjeta', action: 'card.add', fields: [{ name: 'kind', label: 'Tarjeta de prueba', type: 'select', options: [{ value: 'tok_ok', label: 'Válida' }, { value: 'tok_3ds', label: 'Pide 3-D Secure' }, { value: 'tok_decline', label: 'Fondos insuficientes al cobrar' }, { value: 'tok_card_compartida', label: 'Tarjeta compartida (antifraude)' }] }] },
      { label: 'Banco: resolver 3-D Secure', action: 'card.3ds', fields: [{ name: 'result', label: 'Resultado', type: 'select', options: [{ value: 'authenticated', label: 'Autenticado' }, { value: 'failed', label: 'Fallido' }] }] },
      { label: 'Mis tarjetas', action: 'card.list' },
      { label: 'Recibo del último viaje', action: 'trip.receipt' },
      { label: 'Pagar deuda con otra tarjeta', action: 'payment.retry' },
      { label: 'Mi billetera', action: 'wallet', hint: 'Sin recargas: solo reembolsos y créditos.' },
    ],
  },
  {
    title: 'Módulo 7 · Ganancias y retiros',
    roles: ['driver'],
    note: 'Cuenta bancaria y retiros exigen passkey reciente (crea una y usa "Confirmar con passkey" en el módulo 1).',
    items: [
      { label: 'Mis ganancias', action: 'driver.earnings' },
      { label: 'Registrar cuenta bancaria', action: 'driver.payoutAccount', hint: 'Debe estar a tu nombre (misma cédula del KYC). 72 h de espera.', fields: [{ name: 'bankCode', label: 'Banco', type: 'select', options: ['PICHINCHA', 'GUAYAQUIL', 'PACIFICO', 'PRODUBANCO', 'BOLIVARIANO'].map((b) => ({ value: b, label: b })) }, { name: 'accountNumber', label: 'Nº de cuenta', default: '2201234567' }, { name: 'holderName', label: 'Titular', default: 'Juan Carlos Mora' }, { name: 'holderCedula', label: 'Cédula del titular', default: '0912345675' }] },
      { label: 'Retirar', action: 'driver.payout', fields: [{ name: 'amountCents', label: 'Monto (centavos)', default: '500' }] },
    ],
  },
  {
    title: 'Módulo 6 · En vivo (mapa, chat y enlaces)',
    roles: MOBILE,
    note: 'Necesita un viaje aceptado. El enlace de seguimiento se abre en el navegador (página pública con mapa).',
    items: [
      { label: 'Escuchar en vivo', action: 'rt.listen', hint: 'WebSocket autenticado con DPoP.' },
      { label: 'Ver mensajes recibidos', action: 'rt.messages' },
      { label: 'Enviar chat', action: 'chat.send', hint: 'Los teléfonos y correos se ocultan.', fields: [{ name: 'text', label: 'Mensaje', default: 'Estoy en la puerta 3, mi número es 0991234567' }] },
      { label: 'Compartir viaje con un contacto', action: 'trip.share', roles: ['passenger'], hint: 'Requiere el consentimiento "Compartir viajes" (módulo 2).' },
      { label: 'Conducir automáticamente', action: 'driver.drive', roles: ['driver'], hint: 'Hacia la recogida o el destino; publica la ubicación cada 2 s.' },
      { label: 'Detener conducción', action: 'driver.stop', roles: ['driver'] },
    ],
  },
  {
    title: 'Panel admin · Revisión de conductores',
    roles: ['admin'],
    note: 'Sesión iniciada solo con passkey. Las escrituras exigen passkey de los últimos 15 minutos.',
    items: [
      { label: 'Mis roles', action: 'admin.me' },
      { label: 'Cola de revisión', action: 'admin.drivers', fields: [{ name: 'status', label: 'Estado', type: 'select', options: ['under_review', 'approved', 'rejected', 'suspended', 'applicant'].map((v) => ({ value: v, label: v })) }] },
      { label: 'Detalle del conductor', action: 'admin.driver', fields: [driverId] },
      { label: 'Ver documento (URL 60 s)', action: 'admin.doc.view', hint: 'Exige motivo; queda auditado.', fields: [driverId, { name: 'documentId', label: 'ID del documento' }, { name: 'reason', label: 'Motivo', default: 'Revisión de documentos de onboarding' }] },
      { label: 'Revisar un documento', action: 'admin.doc.review', fields: [driverId, { name: 'documentId', label: 'ID del documento' }, { name: 'decision', label: 'Decisión', type: 'select', options: [{ value: 'approved', label: 'Aprobar' }, { value: 'rejected', label: 'Rechazar' }] }, { name: 'reason', label: 'Motivo (si rechaza)' }] },
      { label: 'Aprobar todos los documentos', action: 'admin.docs.approveAll', fields: [driverId] },
      { label: 'Decidir conductor', action: 'admin.driver.decide', fields: [driverId, { name: 'decision', label: 'Decisión', type: 'select', options: [{ value: 'approve', label: 'Aprobar' }, { value: 'reject', label: 'Rechazar' }, { value: 'suspend', label: 'Suspender' }] }, { name: 'reason', label: 'Motivo', default: 'Documentos en regla' }] },
      { label: 'Asignar rol (super_admin)', action: 'admin.role.grant', fields: [{ name: 'userId', label: 'ID de usuario' }, { name: 'role', label: 'Rol', type: 'select', options: ['driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo'].map((v) => ({ value: v, label: v })) }] },
    ],
  },
  {
    title: 'Panel admin · Pagos y antifraude',
    roles: ['admin'],
    items: [
      { label: 'Acreditar billetera (support)', action: 'admin.wallet.credit', fields: [{ name: 'userId', label: 'ID de usuario' }, { name: 'amountCents', label: 'Centavos (máx. 5000)', default: '1000' }, { name: 'reason', label: 'Motivo', default: 'Compensación por demora' }] },
      { label: 'Reembolsar pago (support)', action: 'admin.refund', fields: [{ name: 'paymentId', label: 'ID del pago (receiptId)' }, { name: 'amountCents', label: 'Centavos' }, { name: 'to', label: 'Destino', type: 'select', options: [{ value: 'original', label: 'Tarjeta' }, { value: 'wallet', label: 'Billetera' }] }, { name: 'reason', label: 'Motivo', default: 'Cobro incorrecto' }] },
      { label: 'Señales de fraude (fraud_analyst)', action: 'admin.fraud' },
      { label: 'Retiros (fraud_analyst)', action: 'admin.payouts', fields: [{ name: 'status', label: 'Estado', type: 'select', options: ['requested', 'under_review', 'paid', 'rejected'].map((v) => ({ value: v, label: v })) }] },
      { label: 'Decidir retiro', action: 'admin.payout.decide', fields: [{ name: 'payoutId', label: 'ID del retiro' }, { name: 'decision', label: 'Decisión', type: 'select', options: [{ value: 'paid', label: 'Pagado' }, { value: 'rejected', label: 'Rechazar' }] }, { name: 'reason', label: 'Referencia / motivo', default: 'Transferencia SPI' }] },
    ],
  },
  {
    title: 'Avanzado · Llamada directa a la API',
    note: 'Firma la petición con la clave DPoP del dispositivo y adjunta el ticket de atestación.',
    items: [
      {
        label: 'Petición manual',
        action: 'call',
        fields: [
          { name: 'service', label: 'Servicio', type: 'select', options: [{ value: 'auth', label: 'auth' }, { value: 'api', label: 'api' }, { value: 'sos', label: 'sos' }] },
          { name: 'method', label: 'Método', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })) },
          { name: 'path', label: 'Ruta', placeholder: '/v1/me' },
          { name: 'body', label: 'Cuerpo JSON', type: 'textarea', placeholder: '{}' },
        ],
        params: (v) => ({ service: v.service, method: v.method, path: v.path, body: v.body ? JSON.parse(v.body) : undefined }),
      },
    ],
  },
];

export const GUIDE = [
  ['h2', 'Cómo usar el simulador'],
  ['p', 'Cada "dispositivo" es una instalación simulada de la app con su propia clave criptográfica, como un teléfono real. Las acciones llaman a los servicios reales que corren en tu computadora.'],
  ['h3', 'Prueba rápida del módulo 1'],
  ['p', '1. Crea un pasajero → "Pedir código SMS" con 0991234567 → "Verificar código" (botón "Usar último código").'],
  ['p', '2. "Ver mi perfil": el número aparece enmascarado. Mira el contador del token (10 minutos).'],
  ['p', '3. Registra un correo y ábrelo con "Usar enlace del último correo". Activa Face ID y crea una passkey.'],
  ['p', '4. Crea otro pasajero con el MISMO número: verás el aviso de "nuevo inicio de sesión" en el correo y el bloqueo anti SIM swap en el perfil. Confirmar con passkey (usando la passkey del primer dispositivo) lo levanta.'],
  ['p', '5. Crea un conductor "rooteado": la atestación lo rechaza. Un pasajero rooteado sí entra, marcado como riesgo.'],
  ['p', 'La pestaña Auditoría muestra cada evento y si la cadena de hash está íntegra.'],
];
