-- Módulo 8: seguridad del viaje. Manifiesto inmutable (versiones encadenadas y firmadas), incidentes SOS/accidente,
-- PIN de seguridad y de coacción, audio cifrado y entregas a autoridades con doble aprobación.
CREATE SCHEMA IF NOT EXISTS safety;

CREATE TABLE safety.trip_manifests (
  id              uuid PRIMARY KEY,
  trip_id         uuid NOT NULL REFERENCES trips.trips (id),
  version         integer NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('start', 'end', 'incident', 'authority_request')),
  payload_enc     bytea NOT NULL,
  payload_sha256  bytea NOT NULL,
  prev_hash       bytea NOT NULL,
  chain_hash      bytea NOT NULL,
  signature       bytea NOT NULL,
  key_id          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (trip_id, version)
);

-- Solo inserción. El borrado por retención (180 días, sin incidente) solo es posible dentro de la
-- función de retención, que activa la marca de sesión; en producción solo el rol "retention_job" tiene DELETE.
CREATE FUNCTION safety.forbid_mutation_unless_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('intitaxi.retention_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'tabla de solo inserción (operación % bloqueada)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER manifests_immutable BEFORE UPDATE OR DELETE ON safety.trip_manifests FOR EACH ROW EXECUTE FUNCTION safety.forbid_mutation_unless_retention();

CREATE TABLE safety.incidents (
  id                 uuid PRIMARY KEY,
  trip_id            uuid NOT NULL REFERENCES trips.trips (id),
  type               text NOT NULL CHECK (type IN ('sos', 'accident', 'other')),
  status             text NOT NULL CHECK (status IN ('open', 'acknowledged', 'escalated', 'cancelled_by_user', 'closed')),
  severity           text NOT NULL DEFAULT 'high' CHECK (severity IN ('medium', 'high', 'critical')),
  opened_by_user_id  uuid,
  opened_by_role     text NOT NULL CHECK (opened_by_role IN ('requester', 'passenger', 'driver', 'link_holder', 'operator')),
  duress             boolean NOT NULL DEFAULT false,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  acknowledged_by    uuid,
  acknowledged_at    timestamptz,
  escalated_at       timestamptz,
  ecu911_status      text NOT NULL DEFAULT 'not_sent' CHECK (ecu911_status IN ('not_sent', 'simulated', 'awaiting_operator', 'sent', 'failed')),
  ecu911_ref         text,
  closed_by          uuid,
  closed_at          timestamptz,
  resolution         text,
  legal_hold_until   timestamptz
);
CREATE UNIQUE INDEX incidents_one_open_per_trip ON safety.incidents (trip_id) WHERE status IN ('open', 'acknowledged', 'escalated');
CREATE INDEX incidents_status_idx ON safety.incidents (status, opened_at);

CREATE TABLE safety.sos_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES safety.incidents (id),
  kind         text NOT NULL,
  actor_role   text NOT NULL,
  actor_id     uuid,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sos_events_incident_idx ON safety.sos_events (incident_id, id);
CREATE TRIGGER sos_events_immutable BEFORE UPDATE OR DELETE ON safety.sos_events FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

CREATE TABLE safety.audio_chunks (
  id            uuid PRIMARY KEY,
  incident_id   uuid NOT NULL REFERENCES safety.incidents (id),
  seq           integer NOT NULL,
  storage_key   text NOT NULL UNIQUE,
  content_type  text NOT NULL,
  sha256        bytea NOT NULL,
  size_bytes    integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, seq)
);

-- PIN de seguridad (para cancelar un SOS) y PIN de coacción (aparenta cancelar, pero agrava la alerta).
CREATE TABLE safety.safety_pins (
  user_id     uuid PRIMARY KEY,
  pin_mac     bytea NOT NULL,
  duress_mac  bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE safety.authority_disclosures (
  id              uuid PRIMARY KEY,
  incident_id     uuid REFERENCES safety.incidents (id),
  trip_id         uuid NOT NULL REFERENCES trips.trips (id),
  authority       text NOT NULL,
  legal_basis     text NOT NULL,
  requested_by    uuid NOT NULL,
  approved_by     uuid,
  status          text NOT NULL CHECK (status IN ('pending_approval', 'active', 'rejected', 'revoked', 'expired')),
  token_hash      bytea UNIQUE,
  expires_at      timestamptz,
  max_views       integer NOT NULL DEFAULT 5,
  views           integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
