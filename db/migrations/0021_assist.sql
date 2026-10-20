-- 12F: grúas y alquiler de vehículos. El usuario oferta cuánto quiere pagar y el primer proveedor
-- verificado que acepta se lleva el servicio.

-- Vehículos de proveedores: grúa (1–2 asientos de cabina) y vehículo para alquiler (1–8).
ALTER TABLE drivers.vehicles DROP CONSTRAINT vehicles_vehicle_type_check;
ALTER TABLE drivers.vehicles ADD CONSTRAINT vehicles_vehicle_type_check CHECK (vehicle_type IN ('taxi', 'van', 'tow', 'rental'));
ALTER TABLE drivers.vehicles DROP CONSTRAINT vehicles_seats_by_type;
ALTER TABLE drivers.vehicles ADD CONSTRAINT vehicles_seats_by_type CHECK (
  (vehicle_type = 'taxi' AND seats_passenger BETWEEN 1 AND 4) OR (vehicle_type = 'van' AND seats_passenger BETWEEN 5 AND 15) OR
  (vehicle_type = 'tow' AND seats_passenger BETWEEN 1 AND 2) OR (vehicle_type = 'rental' AND seats_passenger BETWEEN 1 AND 8)
) NOT VALID;
-- Categoría del vehículo de alquiler (para emparejar con lo que pide el usuario).
ALTER TABLE drivers.vehicles ADD COLUMN rental_category text CHECK (rental_category IN ('auto', 'suv', 'camioneta', 'furgoneta'));

CREATE SCHEMA IF NOT EXISTS assist;

CREATE TABLE assist.requests (
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('tow', 'rental')),
  requester_user_id   uuid NOT NULL,
  status              text NOT NULL CHECK (status IN ('open', 'accepted', 'arrived', 'in_progress', 'completed', 'cancelled', 'expired')),
  -- Oferta del usuario y rango sugerido por la app (el usuario puede subir su oferta mientras espera).
  offer_cents         integer NOT NULL CHECK (offer_cents > 0),
  suggested_min_cents integer NOT NULL,
  suggested_max_cents integer NOT NULL,
  pickup_lat          numeric(9, 6) NOT NULL,
  pickup_lng          numeric(9, 6) NOT NULL,
  pickup_label_enc    bytea,
  dest_lat            numeric(9, 6),
  dest_lng            numeric(9, 6),
  dest_label_enc      bytea,
  distance_m          integer,
  -- Grúa: categoría y problema. Alquiler: categoría, fecha de inicio y días.
  vehicle_category    text NOT NULL,
  problem             text,
  start_date          date,
  days                integer CHECK (days IS NULL OR days BETWEEN 1 AND 30),
  notes_enc           bytea,
  payment_method      text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash')),
  provider_id         uuid,
  vehicle_id          uuid REFERENCES drivers.vehicles (id),
  commission_cents    integer,
  rating              smallint CHECK (rating BETWEEN 1 AND 5),
  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  completed_at        timestamptz,
  expires_at          timestamptz NOT NULL,
  CHECK (provider_id IS NULL OR provider_id <> requester_user_id)
);
CREATE INDEX assist_open_idx ON assist.requests (kind, status, created_at) WHERE status = 'open';
CREATE UNIQUE INDEX assist_one_active_per_user ON assist.requests (requester_user_id, kind) WHERE status IN ('open', 'accepted', 'arrived', 'in_progress');

ALTER TABLE payments.commission_settings DROP CONSTRAINT commission_settings_key_check;
ALTER TABLE payments.commission_settings ADD CONSTRAINT commission_settings_key_check CHECK (key IN ('on_demand_bps', 'route_fee_taxi_cents', 'route_fee_van_cents', 'assist_bps'));
-- Comisión de grúas y alquiler: 9 % del precio aceptado (editable por super_admin).
INSERT INTO payments.commission_settings (key, value) VALUES ('assist_bps', 900) ON CONFLICT (key) DO NOTHING;
