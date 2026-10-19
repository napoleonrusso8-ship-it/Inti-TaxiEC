// Acciones del simulador por módulo. Cada módulo nuevo agrega su sección aquí.
const phoneDefault = (d) => d.phone ?? '';

export const SECTIONS = [
  {
    title: 'Módulo 1 · Registro e inicio de sesión',
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
