-- Log de auditoría inmutable con hash encadenado.
-- Cada fila incluye el hash de la anterior; alterar o borrar una fila rompe la cadena (audit.verify_chain).
-- Además se replica a S3 con Object Lock (fuera de la BD) para resistir a un administrador de BD malicioso.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE SEQUENCE audit.audit_log_seq;

CREATE TABLE audit.audit_log (
  seq             bigint PRIMARY KEY,
  ts              timestamptz NOT NULL,
  actor_user_id   uuid,
  actor_role      text,
  actor_device_id uuid,
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  outcome         text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  purpose         text,
  justification   text,
  ip_hmac         bytea,
  request_id      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       bytea NOT NULL,
  hash            bytea NOT NULL
);

CREATE INDEX audit_log_actor_idx ON audit.audit_log (actor_user_id, ts);
CREATE INDEX audit_log_resource_idx ON audit.audit_log (resource_type, resource_id, ts);

-- La marca de tiempo se serializa en microsegundos desde epoch para que el hash no dependa
-- del parámetro TimeZone de la sesión.
CREATE FUNCTION audit.row_digest(prev bytea, r audit.audit_log) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(prev || convert_to(jsonb_build_object(
    'seq', r.seq, 'ts_us', (extract(epoch FROM r.ts) * 1000000)::bigint, 'actor_user_id', r.actor_user_id, 'actor_role', r.actor_role,
    'actor_device_id', r.actor_device_id, 'action', r.action, 'resource_type', r.resource_type,
    'resource_id', r.resource_id, 'outcome', r.outcome, 'purpose', r.purpose,
    'justification', r.justification, 'ip_hmac', encode(r.ip_hmac, 'hex'),
    'request_id', r.request_id, 'metadata', r.metadata)::text, 'UTF8'))
$$;

-- El número de secuencia y el hash se asignan DESPUÉS de tomar el candado, para que el orden
-- de la cadena coincida con el orden de confirmación aunque haya inserciones concurrentes.
CREATE FUNCTION audit.chain_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(727275);
  NEW.seq := nextval('audit.audit_log_seq');
  NEW.ts := clock_timestamp();
  SELECT hash INTO last_hash FROM audit.audit_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, '\x00'::bytea);
  NEW.hash := audit.row_digest(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.chain_before_insert();

CREATE FUNCTION audit.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción (operación % bloqueada)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_mutation();

-- Devuelve el primer seq cuya cadena no cuadra, o NULL si la cadena está íntegra.
CREATE FUNCTION audit.verify_chain() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit.audit_log;
  expected_prev bytea := '\x00'::bytea;
BEGIN
  FOR r IN SELECT * FROM audit.audit_log ORDER BY seq LOOP
    IF r.prev_hash <> expected_prev OR r.hash <> audit.row_digest(r.prev_hash, r) THEN
      RETURN r.seq;
    END IF;
    expected_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;
