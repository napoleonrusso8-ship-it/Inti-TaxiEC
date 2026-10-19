-- Claves App Attest (iOS). Solo la clave pública y el contador; nunca material privado.
CREATE TABLE identity.app_attest_keys (
  key_id          text PRIMARY KEY,
  app_id          text NOT NULL,
  public_key_der  bytea NOT NULL,
  sign_count      bigint NOT NULL DEFAULT 0,
  receipt         bytea,
  environment     text NOT NULL CHECK (environment IN ('production', 'development')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
