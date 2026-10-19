-- Módulo 5: personas que viajan (titulares de datos LOPDP), acompañantes, terceros y enlaces.
-- Cada registro de persona pertenece a UN viaje: así cada manifiesto vence por separado (180 días).
CREATE SCHEMA IF NOT EXISTS people;

CREATE TABLE people.persons (
  id                   uuid PRIMARY KEY,
  user_id              uuid,               -- si la persona tiene cuenta (p. ej. el solicitante que viaja)
  given_names_enc      bytea,
  family_names_enc     bytea,
  id_doc_type          text NOT NULL CHECK (id_doc_type IN ('cedula', 'passport', 'none')),
  id_doc_number_enc    bytea,
  id_doc_hmac          bytea,
  id_doc_masked        text,
  id_doc_country       text,
  email_enc            bytea,
  email_hmac           bytea,
  phone_enc            bytea,
  is_minor             boolean NOT NULL DEFAULT false,
  guardian_person_id   uuid REFERENCES people.persons (id),
  created_by_user_id   uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Borrado criptográfico: al vencer se anulan los campos cifrados y los índices ciegos.
  anonymized_at        timestamptz
);
CREATE INDEX persons_user_idx ON people.persons (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE trips.trip_parties (
  trip_id                uuid NOT NULL REFERENCES trips.trips (id),
  person_id              uuid NOT NULL REFERENCES people.persons (id),
  role                   text NOT NULL CHECK (role IN ('requester', 'primary_passenger', 'companion')),
  responsible_person_id  uuid REFERENCES people.persons (id),
  notified_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, person_id, role)
);
CREATE INDEX trip_parties_person_idx ON trips.trip_parties (person_id);

-- Contactos frecuentes: solo utilizables tras el consentimiento del propio acompañante.
CREATE TABLE people.saved_companions (
  id                  uuid PRIMARY KEY,
  owner_user_id       uuid NOT NULL,
  alias               text,
  given_names_enc     bytea NOT NULL,
  family_names_enc    bytea NOT NULL,
  id_doc_type         text NOT NULL CHECK (id_doc_type IN ('cedula', 'passport', 'none')),
  id_doc_number_enc   bytea,
  id_doc_masked       text,
  id_doc_country      text,
  email_enc           bytea,
  is_minor            boolean NOT NULL DEFAULT false,
  consent_status      text NOT NULL CHECK (consent_status IN ('pending', 'granted', 'revoked', 'guardian_declared')),
  consent_at          timestamptz,
  consent_text_version integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX saved_companions_owner_idx ON people.saved_companions (owner_user_id) WHERE deleted_at IS NULL;

-- Enlaces firmados para titulares sin cuenta: aviso LOPDP (consultar / confirmar / pedir eliminación) y consentimiento.
CREATE TABLE people.subject_links (
  token_hash          bytea PRIMARY KEY,
  purpose             text NOT NULL CHECK (purpose IN ('notice', 'companion_consent')),
  person_id           uuid REFERENCES people.persons (id),
  saved_companion_id  uuid REFERENCES people.saved_companions (id),
  trip_id             uuid REFERENCES trips.trips (id),
  expires_at          timestamptz NOT NULL,
  confirmed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people.data_subject_requests (
  id           uuid PRIMARY KEY,
  person_id    uuid REFERENCES people.persons (id),
  user_id      uuid,
  type         text NOT NULL CHECK (type IN ('access', 'rectify', 'delete', 'portability', 'object')),
  status       text NOT NULL CHECK (status IN ('received', 'completed', 'deferred_legal_hold', 'rejected')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,
  resolved_at  timestamptz
);

-- Enlaces de seguimiento en vivo (terceros sin app, contactos de confianza, autoridades).
CREATE TABLE trips.share_links (
  id           uuid PRIMARY KEY,
  trip_id      uuid NOT NULL REFERENCES trips.trips (id),
  audience     text NOT NULL CHECK (audience IN ('third_party', 'companion', 'trusted_contact', 'requester')),
  person_id    uuid REFERENCES people.persons (id),
  token_hash   bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX share_links_trip_idx ON trips.share_links (trip_id);
