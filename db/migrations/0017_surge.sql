-- 12B: tarifa dinámica. Se guarda el desglose con el que se cotizó (el precio queda fijo).
ALTER TABLE trips.trips ADD COLUMN base_fare_cents integer;
ALTER TABLE trips.trips ADD COLUMN surge_cents integer NOT NULL DEFAULT 0 CHECK (surge_cents >= 0);
ALTER TABLE trips.trips ADD COLUMN surge_multiplier numeric(3, 2) NOT NULL DEFAULT 1 CHECK (surge_multiplier BETWEEN 1 AND 3);
CREATE INDEX trips_recent_demand_idx ON trips.trips (requested_at) WHERE status IN ('matching', 'no_drivers');
