-- 13: solicitudes de habilitación en Taxi Ruta desde la app (dueños de taxi amarillo y de furgoneta).
-- Al aprobarse se crea la habilitación de siempre (fixed_routes.driver_enablements).
CREATE TABLE fixed_routes.enablement_requests (
  id          uuid PRIMARY KEY,
  driver_id   uuid NOT NULL REFERENCES drivers.profiles (user_id),
  route_id    uuid NOT NULL REFERENCES fixed_routes.routes (id),
  vehicle_id  uuid NOT NULL REFERENCES drivers.vehicles (id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid,
  decided_at  timestamptz,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- Una sola solicitud pendiente por socio y ruta.
CREATE UNIQUE INDEX enablement_requests_one_pending ON fixed_routes.enablement_requests (driver_id, route_id) WHERE status = 'pending';
CREATE INDEX enablement_requests_status_idx ON fixed_routes.enablement_requests (status, created_at);
