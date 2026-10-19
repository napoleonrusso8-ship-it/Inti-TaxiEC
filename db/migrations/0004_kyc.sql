-- Módulo 2: consentimientos y verificación de identidad (KYC).
-- NO se almacenan imágenes, vídeos ni plantillas biométricas: solo el resultado, la referencia del proveedor y la fecha.
CREATE SCHEMA IF NOT EXISTS kyc;

-- Textos de consentimiento versionados. ⚠️ BORRADORES: requieren revisión legal (LOPDP) antes de producción.
CREATE TABLE kyc.consent_texts (
  purpose       text NOT NULL,
  version       integer NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  sha256        text NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (purpose, version)
);

-- Registro de consentimientos: solo inserción (otorgar / revocar), nunca se edita.
CREATE TABLE kyc.consents (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  purpose       text NOT NULL,
  action        text NOT NULL CHECK (action IN ('grant', 'revoke')),
  text_version  integer,
  text_sha256   text,
  device_id     uuid,
  ip_hmac       bytea,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX consents_user_idx ON kyc.consents (user_id, purpose, created_at DESC);
CREATE TRIGGER consents_no_update BEFORE UPDATE OR DELETE ON kyc.consents FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

CREATE VIEW kyc.current_consents AS
  SELECT DISTINCT ON (user_id, purpose) user_id, purpose, action, text_version, created_at
  FROM kyc.consents ORDER BY user_id, purpose, created_at DESC;

CREATE TABLE kyc.verifications (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL,
  kind                     text NOT NULL CHECK (kind IN ('full', 'driver_reverify')),
  provider                 text NOT NULL,
  provider_session_ref     text UNIQUE,
  status                   text NOT NULL CHECK (status IN ('created', 'approved', 'declined', 'resubmission_requested',
                             'expired', 'abandoned', 'duplicate_review', 'superseded', 'revoked')),
  reason                   text,
  risk_score               numeric(5, 2),
  doc_type                 text,
  doc_country              text,
  doc_number_enc           bytea,
  doc_number_hmac          bytea,
  doc_number_masked        text,
  given_names_enc          bytea,
  family_names_enc         bytea,
  device_id                uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  decided_at               timestamptz,
  -- Fecha a partir de la cual se pide al proveedor borrar imágenes/vídeo de la sesión.
  provider_delete_after    timestamptz,
  provider_data_deleted_at timestamptz
);
CREATE INDEX verifications_user_idx ON kyc.verifications (user_id, kind, created_at DESC);
-- Un mismo documento no puede estar aprobado en dos cuentas a la vez (antifraude).
CREATE UNIQUE INDEX verifications_doc_approved_uniq ON kyc.verifications (doc_number_hmac) WHERE status = 'approved' AND kind = 'full';

-- Idempotencia de webhooks del proveedor.
CREATE TABLE kyc.provider_events (
  event_hash   bytea PRIMARY KEY,
  provider     text NOT NULL,
  session_ref  text,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Exigencias de re-verificación de conductores (selfie en vivo antes de conectarse).
CREATE TABLE kyc.reverification_requests (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  reason           text NOT NULL,
  device_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  verification_id  uuid REFERENCES kyc.verifications (id),
  satisfied_at     timestamptz
);
CREATE INDEX reverification_open_idx ON kyc.reverification_requests (user_id) WHERE satisfied_at IS NULL;

INSERT INTO kyc.consent_texts (purpose, version, title, body, sha256) VALUES
('biometric_kyc', 1, 'Verificación de identidad con biometría',
 'BORRADOR — REQUIERE REVISIÓN LEGAL. Para proteger a pasajeros y conductores, Inti Taxi verifica tu identidad comparando una selfie con prueba de vida con la foto de tu cédula o pasaporte. Este proceso lo realiza nuestro proveedor certificado (encargado del tratamiento). Inti Taxi NO guarda tus imágenes ni tu plantilla biométrica: solo el resultado (aprobado/rechazado), la fecha y una referencia. El proveedor elimina las imágenes a los 30 días. Base legal: tu consentimiento explícito (LOPDP art. 26). Puedes revocarlo en cualquier momento desde Ajustes > Privacidad; si eres conductor, sin esta verificación no podrás conectarte. Tienes derecho de acceso, rectificación, eliminación, oposición y portabilidad escribiendo a privacidad@intitaxi.ec.', ''),
('audio_recording', 1, 'Grabación de audio durante una emergencia',
 'BORRADOR — REQUIERE REVISIÓN LEGAL. Si activas el botón SOS, Inti Taxi grabará el audio de TU teléfono mientras dure la emergencia para ayudar a las autoridades. La grabación se cifra, solo la ven personas autorizadas del centro de monitoreo y se elimina a los 90 días salvo que exista una investigación. Puedes revocar este permiso cuando quieras.', ''),
('trip_sharing', 1, 'Compartir viajes con contactos de confianza',
 'BORRADOR — REQUIERE REVISIÓN LEGAL. Autorizas a Inti Taxi a enviar a tus contactos de confianza un enlace temporal con la ubicación en vivo de tu viaje, los datos del conductor y la placa. El enlace caduca al terminar el viaje.', ''),
('companion_data', 1, 'Guardar mis datos como acompañante frecuente',
 'BORRADOR — REQUIERE REVISIÓN LEGAL. Autorizas a que la persona que te registró guarde tus nombres, número de identificación y correo para registrarte como acompañante en futuros viajes, con la única finalidad de la seguridad del viaje y la atención de emergencias. Puedes retirar esta autorización y pedir la eliminación de tus datos con el enlace que te enviamos.', '');
UPDATE kyc.consent_texts SET sha256 = encode(sha256(convert_to(title || E'\n' || body, 'UTF8')), 'hex');
