-- 12A: furgonetas (Taxi Ruta) y modelo de comisiones configurable.

-- Tipo de vehículo y asientos según el tipo. Los asientos declarados los confirma el revisor contra la matrícula.
ALTER TABLE drivers.vehicles ADD COLUMN vehicle_type text NOT NULL DEFAULT 'taxi' CHECK (vehicle_type IN ('taxi', 'van'));
ALTER TABLE drivers.vehicles DROP CONSTRAINT vehicles_seats_passenger_check;
ALTER TABLE drivers.vehicles ADD CONSTRAINT vehicles_seats_by_type CHECK (
  (vehicle_type = 'taxi' AND seats_passenger BETWEEN 1 AND 4) OR (vehicle_type = 'van' AND seats_passenger BETWEEN 5 AND 15)
) NOT VALID;
ALTER TABLE drivers.vehicles ADD COLUMN seats_verified_by uuid;
ALTER TABLE drivers.vehicles ADD COLUMN seats_verified_at timestamptz;

-- Taxi Ruta: tarifas por tipo de vehículo; el recorrido guarda el tipo con el que salió.
ALTER TABLE fixed_routes.fare_rules ADD COLUMN vehicle_type text NOT NULL DEFAULT 'taxi' CHECK (vehicle_type IN ('taxi', 'van'));
ALTER TABLE fixed_routes.instances ADD COLUMN vehicle_type text NOT NULL DEFAULT 'taxi' CHECK (vehicle_type IN ('taxi', 'van'));
ALTER TABLE fixed_routes.instances DROP CONSTRAINT instances_seats_total_check;
ALTER TABLE fixed_routes.instances ADD CONSTRAINT instances_seats_total_check CHECK (seats_total BETWEEN 1 AND 15);
ALTER TABLE fixed_routes.bookings DROP CONSTRAINT bookings_seats_check;
ALTER TABLE fixed_routes.bookings ADD CONSTRAINT bookings_seats_check CHECK (seats BETWEEN 1 AND 15);
-- Comisión fija por recorrido de Taxi Ruta, cobrada una sola vez al terminar (si llevó pasajeros).
ALTER TABLE fixed_routes.instances ADD COLUMN platform_fee_cents integer;

-- Furgonetas de la Ruta 1 (decisión del propietario): $2.80 diurna, $3.80 nocturna, por persona.
INSERT INTO fixed_routes.fare_rules (id, route_id, name, start_local, end_local, amount_cents, vehicle_type)
SELECT gen_random_uuid(), r.id, x.name, x.s::time, x.e::time, x.amount, 'van'
FROM fixed_routes.routes r, (VALUES ('Diurna', '06:30', '21:00', 280), ('Nocturna', '21:00', '06:30', 380)) AS x(name, s, e, amount)
WHERE r.code = 'R1' AND NOT EXISTS (SELECT 1 FROM fixed_routes.fare_rules f WHERE f.route_id = r.id AND f.vehicle_type = 'van');

-- Comisiones de la plataforma: editables desde el panel (super_admin), con historial.
CREATE TABLE payments.commission_settings (
  key         text PRIMARY KEY CHECK (key IN ('on_demand_bps', 'route_fee_taxi_cents', 'route_fee_van_cents')),
  value       integer NOT NULL CHECK (value >= 0),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payments.commission_settings (key, value) VALUES
  ('on_demand_bps', 900),          -- 9 % de la tarifa base de los viajes bajo demanda
  ('route_fee_taxi_cents', 90),    -- $0.90 por recorrido de Taxi Ruta en taxi
  ('route_fee_van_cents', 250)     -- $2.50 por recorrido de Taxi Ruta en furgoneta
ON CONFLICT (key) DO NOTHING;
