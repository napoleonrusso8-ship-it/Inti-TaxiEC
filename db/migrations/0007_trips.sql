-- Módulo 4: viajes, ofertas a conductores, eventos y calificaciones.
-- Coordenadas como lat/lng numéricos (emparejamiento con Redis GEO). Las direcciones de texto se cifran.
CREATE SCHEMA IF NOT EXISTS trips;

-- Conexiones del conductor (cada "turno" queda ligado a la re-verificación y al dispositivo usados).
CREATE TABLE drivers.online_sessions (
  id          uuid PRIMARY KEY,
  driver_id   uuid NOT NULL REFERENCES drivers.profiles (user_id),
  vehicle_id  uuid NOT NULL REFERENCES drivers.vehicles (id),
  device_id   uuid NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE UNIQUE INDEX online_sessions_one_open ON drivers.online_sessions (driver_id) WHERE ended_at IS NULL;

CREATE TABLE trips.trips (
  id                  uuid PRIMARY KEY,
  type                text NOT NULL DEFAULT 'on_demand' CHECK (type IN ('on_demand', 'fixed_route')),
  requester_user_id   uuid NOT NULL,
  driver_id           uuid,
  vehicle_id          uuid,
  status              text NOT NULL CHECK (status IN ('matching', 'no_drivers', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled')),
  origin_lat          numeric(9, 6) NOT NULL,
  origin_lng          numeric(9, 6) NOT NULL,
  origin_label_enc    bytea,
  dest_lat            numeric(9, 6) NOT NULL,
  dest_lng            numeric(9, 6) NOT NULL,
  dest_label_enc      bytea,
  distance_m          integer NOT NULL,
  duration_s          integer NOT NULL,
  quoted_fare_cents   integer NOT NULL CHECK (quoted_fare_cents >= 0),
  final_fare_cents    integer,
  currency            text NOT NULL DEFAULT 'USD',
  party_size          integer NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 8),
  payment_method      text NOT NULL CHECK (payment_method IN ('cash', 'card', 'wallet')),
  payment_method_id   uuid,
  pin_enc             bytea NOT NULL,
  pin_attempts        integer NOT NULL DEFAULT 0,
  search_radius_m     integer NOT NULL DEFAULT 5000,
  is_for_third_party  boolean NOT NULL DEFAULT false,
  incident_hold       boolean NOT NULL DEFAULT false,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  arrived_at          timestamptz,
  started_at          timestamptz,
  ended_at            timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        text CHECK (cancelled_by IN ('requester', 'driver', 'system', 'admin')),
  cancel_reason       text,
  retention_until     timestamptz
);
CREATE INDEX trips_requester_idx ON trips.trips (requester_user_id, requested_at DESC);
CREATE INDEX trips_driver_idx ON trips.trips (driver_id, requested_at DESC);
CREATE INDEX trips_matching_idx ON trips.trips (status) WHERE status = 'matching';
-- Un pasajero no puede tener dos viajes activos; un conductor tampoco.
CREATE UNIQUE INDEX trips_one_active_requester ON trips.trips (requester_user_id) WHERE status IN ('matching', 'accepted', 'arrived', 'in_progress') AND type = 'on_demand';
CREATE UNIQUE INDEX trips_one_active_driver ON trips.trips (driver_id) WHERE status IN ('accepted', 'arrived', 'in_progress') AND type = 'on_demand';

CREATE TABLE trips.offers (
  id            uuid PRIMARY KEY,
  trip_id       uuid NOT NULL REFERENCES trips.trips (id),
  driver_id     uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'superseded')),
  distance_m    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  responded_at  timestamptz,
  UNIQUE (trip_id, driver_id)
);
CREATE INDEX offers_driver_pending_idx ON trips.offers (driver_id) WHERE status = 'pending';
CREATE INDEX offers_expiry_idx ON trips.offers (expires_at) WHERE status = 'pending';

-- Historial de estados (solo inserción): base de la línea de tiempo del manifiesto.
CREATE TABLE trips.trip_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES trips.trips (id),
  event       text NOT NULL,
  actor_role  text NOT NULL,
  actor_id    uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX trip_events_trip_idx ON trips.trip_events (trip_id, id);
CREATE TRIGGER trip_events_no_update BEFORE UPDATE OR DELETE ON trips.trip_events FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

CREATE TABLE trips.ratings (
  trip_id        uuid NOT NULL REFERENCES trips.trips (id),
  rater_user_id  uuid NOT NULL,
  ratee_user_id  uuid NOT NULL,
  stars          smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment_enc    bytea,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, rater_user_id)
);
CREATE INDEX ratings_ratee_idx ON trips.ratings (ratee_user_id);
