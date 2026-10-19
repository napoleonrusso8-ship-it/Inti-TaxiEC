-- Módulo 9: Taxi Ruta (rutas fijas compartidas, cobro por persona). Todo configurable desde el panel:
-- agregar la Ruta 2, 3… no requiere cambiar código.
CREATE SCHEMA IF NOT EXISTS fixed_routes;

CREATE TABLE fixed_routes.routes (
  id                     uuid PRIMARY KEY,
  code                   text NOT NULL UNIQUE CHECK (code ~ '^R[0-9]{1,3}$'),
  name                   text NOT NULL,
  city                   text NOT NULL DEFAULT 'Guayaquil',
  status                 text NOT NULL CHECK (status IN ('draft', 'pending_approval', 'active', 'paused')),
  corridor               text,
  created_by             uuid,
  publish_requested_by   uuid,
  published_by           uuid,
  published_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (published_by IS NULL OR published_by <> publish_requested_by)
);

CREATE TABLE fixed_routes.directions (
  id                 uuid PRIMARY KEY,
  route_id           uuid NOT NULL REFERENCES fixed_routes.routes (id),
  direction          text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  label              text NOT NULL,
  path               jsonb,
  validated_at       timestamptz,
  validation_report  jsonb,
  UNIQUE (route_id, direction)
);

CREATE TABLE fixed_routes.stops (
  id                 uuid PRIMARY KEY,
  name               text NOT NULL,
  reference          text,
  lat                numeric(9, 6) NOT NULL,
  lng                numeric(9, 6) NOT NULL,
  -- Coordenadas confirmadas en terreno / con la API de mapas por el equipo de rutas.
  location_verified  boolean NOT NULL DEFAULT false
);

CREATE TABLE fixed_routes.direction_stops (
  direction_id  uuid NOT NULL REFERENCES fixed_routes.directions (id),
  stop_id       uuid NOT NULL REFERENCES fixed_routes.stops (id),
  seq           integer NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (direction_id, seq),
  UNIQUE (direction_id, stop_id)
);

-- Tarifa por persona y franja horaria LOCAL (America/Guayaquil): [start_local, end_local); puede cruzar medianoche.
CREATE TABLE fixed_routes.fare_rules (
  id            uuid PRIMARY KEY,
  route_id      uuid NOT NULL REFERENCES fixed_routes.routes (id),
  name          text NOT NULL,
  start_local   time NOT NULL,
  end_local     time NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  currency      text NOT NULL DEFAULT 'USD',
  valid_from    date NOT NULL DEFAULT '2000-01-01',
  valid_to      date,
  priority      integer NOT NULL DEFAULT 0,
  -- Las reglas no se borran (las reservas las referencian para el recibo): se retiran.
  retired_at    timestamptz,
  CHECK (start_local <> end_local)
);

CREATE TABLE fixed_routes.schedules (
  id                   uuid PRIMARY KEY,
  route_id             uuid NOT NULL REFERENCES fixed_routes.routes (id),
  days_of_week         integer[] NOT NULL,
  service_start_local  time NOT NULL,
  service_end_local    time NOT NULL,
  headway_minutes      integer NOT NULL CHECK (headway_minutes BETWEEN 1 AND 180)
);

CREATE TABLE fixed_routes.driver_enablements (
  driver_id   uuid NOT NULL,
  route_id    uuid NOT NULL REFERENCES fixed_routes.routes (id),
  enabled_by  uuid NOT NULL,
  enabled_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid
);
CREATE UNIQUE INDEX driver_enablements_active ON fixed_routes.driver_enablements (driver_id, route_id) WHERE revoked_at IS NULL;

-- Un recorrido de un vehículo en un sentido.
CREATE TABLE fixed_routes.instances (
  id            uuid PRIMARY KEY,
  direction_id  uuid NOT NULL REFERENCES fixed_routes.directions (id),
  driver_id     uuid NOT NULL,
  vehicle_id    uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('in_service', 'finished')),
  seats_total   integer NOT NULL CHECK (seats_total BETWEEN 1 AND 8),
  seats_taken   integer NOT NULL DEFAULT 0,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CHECK (seats_taken BETWEEN 0 AND seats_total)
);
CREATE UNIQUE INDEX instances_one_per_driver ON fixed_routes.instances (driver_id) WHERE status = 'in_service';

CREATE TABLE fixed_routes.bookings (
  id                         uuid PRIMARY KEY,
  instance_id                uuid NOT NULL REFERENCES fixed_routes.instances (id),
  trip_id                    uuid NOT NULL UNIQUE REFERENCES trips.trips (id),
  requester_user_id          uuid NOT NULL,
  boarding_stop_id           uuid NOT NULL REFERENCES fixed_routes.stops (id),
  alighting_stop_id          uuid NOT NULL REFERENCES fixed_routes.stops (id),
  seats                      integer NOT NULL CHECK (seats BETWEEN 1 AND 8),
  status                     text NOT NULL CHECK (status IN ('reserved', 'boarded', 'completed', 'cancelled', 'expired')),
  estimated_unit_fare_cents  integer NOT NULL,
  -- Tarifa CONGELADA al confirmar el abordaje (decisión aprobada: hora de subida en America/Guayaquil).
  fare_rule_id               uuid REFERENCES fixed_routes.fare_rules (id),
  fare_rule_name             text,
  unit_fare_cents            integer,
  boarded_at                 timestamptz,
  alighted_at                timestamptz,
  expires_at                 timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_instance_idx ON fixed_routes.bookings (instance_id, status);
