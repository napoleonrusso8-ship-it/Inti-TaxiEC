-- Esquema de identidad y sesiones. Propiedad exclusiva del servicio auth.
-- Datos personales: *_enc = AES-256-GCM (envelope encryption); *_hmac = índice ciego.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.users (
  id                          uuid PRIMARY KEY,
  phone_enc                   bytea NOT NULL,
  phone_hmac                  bytea NOT NULL UNIQUE,
  phone_verified_at           timestamptz NOT NULL,
  email_enc                   bytea,
  email_hmac                  bytea UNIQUE,
  email_verified_at           timestamptz,
  status                      text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'locked', 'suspended', 'deleted')),
  kyc_level                   smallint NOT NULL DEFAULT 0,
  -- Tras un cambio de teléfono se bloquean retiros/cambios bancarios (defensa contra SIM swapping).
  sensitive_ops_locked_until  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  deleted_at                  timestamptz
);

CREATE TABLE identity.devices (
  id                  uuid PRIMARY KEY,
  user_id             uuid REFERENCES identity.users (id),
  platform            text NOT NULL CHECK (platform IN ('android', 'ios')),
  -- Thumbprint (RFC 7638) de la clave DPoP no exportable del dispositivo.
  dpop_jkt            text NOT NULL UNIQUE,
  attestation_status  text NOT NULL CHECK (attestation_status IN ('passed', 'failed')),
  attestation_flags   text[] NOT NULL DEFAULT '{}',
  attested_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz
);
CREATE INDEX devices_user_idx ON identity.devices (user_id);

-- Solo claves públicas: passkeys (COSE) y claves de dispositivo protegidas por biometría (JWK).
CREATE TABLE identity.credentials (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES identity.users (id),
  type           text NOT NULL CHECK (type IN ('passkey', 'device_key')),
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea,
  public_jwk     jsonb,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  aaguid         text,
  device_id      uuid REFERENCES identity.devices (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  CHECK ((type = 'passkey' AND public_key IS NOT NULL) OR (type = 'device_key' AND public_jwk IS NOT NULL AND device_id IS NOT NULL))
);
CREATE INDEX credentials_user_idx ON identity.credentials (user_id);

-- Una sesión = una familia de refresh tokens rotativos ligada a una clave DPoP.
CREATE TABLE identity.sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES identity.users (id),
  device_id           uuid NOT NULL REFERENCES identity.devices (id),
  client_id           text NOT NULL,
  dpop_jkt            text NOT NULL,
  current_token_hash  bytea NOT NULL UNIQUE,
  generation          integer NOT NULL DEFAULT 0,
  acr                 text NOT NULL,
  amr                 text[] NOT NULL,
  auth_time           timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_rotated_at     timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text
);
CREATE INDEX sessions_user_idx ON identity.sessions (user_id) WHERE revoked_at IS NULL;

-- Refresh tokens ya rotados: si alguno vuelve a presentarse, es un robo y se revoca la familia.
CREATE TABLE identity.refresh_token_history (
  token_hash  bytea PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES identity.sessions (id),
  rotated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.otp_challenges (
  id            uuid PRIMARY KEY,
  purpose       text NOT NULL CHECK (purpose IN ('login', 'phone_change')),
  phone_hmac    bytea NOT NULL,
  phone_enc     bytea NOT NULL,
  user_id       uuid REFERENCES identity.users (id),
  device_id     uuid NOT NULL REFERENCES identity.devices (id),
  code_mac      bytea NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON identity.otp_challenges (phone_hmac, created_at);

CREATE TABLE identity.email_verifications (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES identity.users (id),
  email_enc    bytea NOT NULL,
  email_hmac   bytea NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
