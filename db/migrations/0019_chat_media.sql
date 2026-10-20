-- 12D: archivos del chat (notas de voz, fotos, videos de hasta 20 s) entre pasajero y conductor.
-- Se guardan cifrados en el almacenamiento (SSE-KMS) y se borran a los 30 días salvo retención por
-- reporte o incidente (legal_hold / incident_hold del viaje).
CREATE TABLE trips.chat_media (
  id              uuid PRIMARY KEY,
  trip_id         uuid NOT NULL REFERENCES trips.trips (id),
  sender_user_id  uuid NOT NULL,
  sender_role     text NOT NULL CHECK (sender_role IN ('requester', 'driver', 'passenger')),
  kind            text NOT NULL CHECK (kind IN ('voice', 'photo', 'video')),
  content_type    text NOT NULL CHECK (content_type IN ('audio/mp4', 'image/jpeg', 'image/png', 'video/mp4')),
  storage_key     text NOT NULL UNIQUE,
  size_bytes      integer NOT NULL CHECK (size_bytes > 0),
  duration_ms     integer,
  status          text NOT NULL CHECK (status IN ('pending', 'ready', 'rejected', 'deleted')),
  reject_reason   text,
  legal_hold      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ready_at        timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX chat_media_trip_idx ON trips.chat_media (trip_id, created_at);
CREATE INDEX chat_media_expiry_idx ON trips.chat_media (expires_at) WHERE status IN ('pending', 'ready', 'rejected');
