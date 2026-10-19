-- Contactos de confianza (los custodia auth: la API solo pide "alerta a los contactos de este usuario").
CREATE TABLE identity.trusted_contacts (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES identity.users (id),
  name_enc    bytea NOT NULL,
  phone_enc   bytea NOT NULL,
  phone_hmac  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (user_id, phone_hmac)
);
CREATE INDEX trusted_contacts_user_idx ON identity.trusted_contacts (user_id) WHERE deleted_at IS NULL;
