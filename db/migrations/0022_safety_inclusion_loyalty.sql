-- 12G: alerta de desvío, Modo Ella, Conductor Aliado, nombre de preferencia, preferencias de viaje e Inti Puntos.

-- Perfil del pasajero en la API (lo de identidad/teléfono sigue en auth).
-- Nunca se pregunta la orientación sexual ni la identidad de género: solo lo que la persona decide declarar
-- para usar una función (nombre de preferencia, "soy mujer" para Modo Ella).
CREATE TABLE people.passenger_profiles (
  user_id                uuid PRIMARY KEY,
  chosen_name_enc        bytea,
  self_identifies_woman  boolean NOT NULL DEFAULT false,
  deviation_alerts       text NOT NULL DEFAULT 'night' CHECK (deviation_alerts IN ('night', 'always', 'off')),
  default_prefs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Conductoras para Modo Ella (autodeclaración revisada por una persona del equipo) y certificación de aliado.
ALTER TABLE drivers.profiles ADD COLUMN women_rides_requested_at timestamptz;
ALTER TABLE drivers.profiles ADD COLUMN women_rides_approved_by uuid;
ALTER TABLE drivers.profiles ADD COLUMN women_rides_approved_at timestamptz;
ALTER TABLE drivers.profiles ADD COLUMN ally_certified_at timestamptz;

-- Características del vehículo (para preferencias que requieren equipamiento).
ALTER TABLE drivers.vehicles ADD COLUMN features text[] NOT NULL DEFAULT '{}'
  CHECK (features <@ ARRAY['ac', 'pet_friendly', 'wheelchair', 'large_luggage']::text[]);

-- Preferencias y filtros del viaje.
ALTER TABLE trips.trips ADD COLUMN prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE trips.trips ADD COLUMN women_only boolean NOT NULL DEFAULT false;
ALTER TABLE trips.trips ADD COLUMN ally_only boolean NOT NULL DEFAULT false;

-- Comprobaciones de seguridad automáticas (desvío o parada larga): si no responde, se escala como SOS.
CREATE TABLE trips.safety_checks (
  id            uuid PRIMARY KEY,
  trip_id       uuid NOT NULL REFERENCES trips.trips (id),
  kind          text NOT NULL CHECK (kind IN ('deviation', 'long_stop')),
  status        text NOT NULL CHECK (status IN ('pending', 'ok', 'help', 'escalated')),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  respond_by    timestamptz NOT NULL,
  responded_at  timestamptz
);
CREATE INDEX safety_checks_pending_idx ON trips.safety_checks (respond_by) WHERE status = 'pending';

ALTER TABLE safety.incidents DROP CONSTRAINT incidents_opened_by_role_check;
ALTER TABLE safety.incidents ADD CONSTRAINT incidents_opened_by_role_check CHECK (opened_by_role IN ('requester', 'passenger', 'driver', 'link_holder', 'operator', 'system'));

-- Inti Puntos: libro de puntos (solo inserción). El canje acredita la billetera desde el gasto promocional.
CREATE SCHEMA IF NOT EXISTS loyalty;
CREATE TABLE loyalty.entries (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('passenger', 'driver')),
  points      integer NOT NULL CHECK (points <> 0),
  kind        text NOT NULL CHECK (kind IN ('trip', 'route', 'assist', 'rating_bonus', 'redeem')),
  ref_id      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, kind, ref_id)
);
CREATE INDEX loyalty_user_idx ON loyalty.entries (user_id, role);
CREATE TRIGGER loyalty_append_only BEFORE UPDATE OR DELETE ON loyalty.entries FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();
