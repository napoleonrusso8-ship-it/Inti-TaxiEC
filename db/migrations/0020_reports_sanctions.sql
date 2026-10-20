-- 12E: reportes de malos tratos (en ambos sentidos) y sanciones con debido proceso.
ALTER TABLE admin.role_assignments DROP CONSTRAINT role_assignments_role_check;
ALTER TABLE admin.role_assignments ADD CONSTRAINT role_assignments_role_check
  CHECK (role IN ('super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo', 'trust_safety'));

CREATE TABLE support.reports (
  id                  uuid PRIMARY KEY,
  trip_id             uuid NOT NULL REFERENCES trips.trips (id),
  reporter_user_id    uuid NOT NULL,
  reporter_role       text NOT NULL CHECK (reporter_role IN ('passenger', 'driver')),
  reported_user_id    uuid NOT NULL,
  reported_role       text NOT NULL CHECK (reported_role IN ('passenger', 'driver')),
  category            text NOT NULL CHECK (category IN ('mistreatment', 'discrimination', 'harassment', 'threats', 'unsafe_driving', 'other')),
  priority            text NOT NULL CHECK (priority IN ('normal', 'high')),
  description_enc     bytea NOT NULL,
  -- Copia del chat al momento del reporte (cifrada): prueba aunque el chat expire.
  chat_snapshot_enc   bytea,
  evidence_media_ids  uuid[] NOT NULL DEFAULT '{}',
  status              text NOT NULL CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  assigned_to         uuid,
  resolution          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CHECK (reporter_user_id <> reported_user_id)
);
CREATE UNIQUE INDEX reports_one_per_trip ON support.reports (trip_id, reporter_user_id);
CREATE INDEX reports_status_idx ON support.reports (status, priority, created_at);

-- Bitácora del caso (solo inserción): contactos con las partes, notas y decisiones.
CREATE TABLE support.report_actions (
  id             bigserial PRIMARY KEY,
  report_id      uuid NOT NULL REFERENCES support.reports (id),
  actor_user_id  uuid NOT NULL,
  action         text NOT NULL CHECK (action IN ('assign', 'contact_reported', 'contact_reporter', 'note', 'decision')),
  note_enc       bytea,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER report_actions_append_only BEFORE UPDATE OR DELETE ON support.report_actions FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

CREATE TABLE support.sanctions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  subject_role  text NOT NULL CHECK (subject_role IN ('passenger', 'driver')),
  type          text NOT NULL CHECK (type IN ('warning', 'suspension', 'ban')),
  status        text NOT NULL CHECK (status IN ('pending_approval', 'active', 'revoked')),
  reason        text NOT NULL,
  report_id     uuid REFERENCES support.reports (id),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  created_by    uuid NOT NULL,
  approved_by   uuid,
  revoked_by    uuid,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- La expulsión exige una segunda persona (cuatro ojos).
  CHECK (type <> 'ban' OR status <> 'active' OR (approved_by IS NOT NULL AND approved_by <> created_by)),
  CHECK (type <> 'suspension' OR ends_at IS NOT NULL)
);
CREATE INDEX sanctions_user_idx ON support.sanctions (user_id, status);
