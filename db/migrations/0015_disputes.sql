-- Módulo 10: disputas de viajes (soporte). La descripción la escribe el usuario y puede contener datos
-- personales: va cifrada a nivel de campo y su lectura en el panel se audita con finalidad.
CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE support.disputes (
  id               uuid PRIMARY KEY,
  trip_id          uuid NOT NULL REFERENCES trips.trips (id),
  opened_by        uuid NOT NULL,
  opener_role      text NOT NULL CHECK (opener_role IN ('requester', 'driver')),
  category         text NOT NULL CHECK (category IN ('fare', 'route', 'conduct', 'lost_item', 'safety', 'other')),
  description_enc  bytea NOT NULL,
  status           text NOT NULL CHECK (status IN ('open', 'in_review', 'resolved', 'rejected')),
  assigned_to      uuid,
  resolution       text,
  refund_cents     integer CHECK (refund_cents IS NULL OR refund_cents > 0),
  resolved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
-- Una disputa abierta por persona y viaje.
CREATE UNIQUE INDEX disputes_one_open ON support.disputes (trip_id, opened_by) WHERE status IN ('open', 'in_review');
CREATE INDEX disputes_status_idx ON support.disputes (status, created_at);
