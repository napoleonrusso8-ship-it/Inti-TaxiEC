-- Horario de servicio de Taxi Ruta. Fuera de él la ruta está CERRADA: no se reserva, no se inicia
-- recorrido ni se confirma abordaje (quien ya va a bordo termina su viaje). NULL = 24 h.
ALTER TABLE fixed_routes.routes
  ADD COLUMN service_start_local time,
  ADD COLUMN service_end_local time,
  ADD CONSTRAINT routes_service_hours CHECK (
    (service_start_local IS NULL AND service_end_local IS NULL)
    OR (service_start_local IS NOT NULL AND service_end_local IS NOT NULL AND service_start_local <> service_end_local)
  );

-- Ruta 1 (horario real indicado por el operador): diurna 06:30–20:59, nocturna 21:00–22:59; desde las 23:00 se cierra.
UPDATE fixed_routes.routes SET service_start_local = '06:30', service_end_local = '23:00' WHERE code = 'R1';

-- La franja nocturna terminaba a las 06:30: se retira (los recibos la siguen citando) y se crea la nueva 21:00–23:00
-- con el mismo valor, para taxi y furgoneta.
WITH old AS (
  UPDATE fixed_routes.fare_rules f SET retired_at = now()
  FROM fixed_routes.routes r
  WHERE r.id = f.route_id AND r.code = 'R1' AND f.retired_at IS NULL AND f.start_local = '21:00' AND f.end_local = '06:30'
  RETURNING f.route_id, f.name, f.amount_cents, f.currency, f.valid_from, f.valid_to, f.priority, f.vehicle_type
)
INSERT INTO fixed_routes.fare_rules (id, route_id, name, start_local, end_local, amount_cents, currency, valid_from, valid_to, priority, vehicle_type)
SELECT gen_random_uuid(), route_id, name, '21:00', '23:00', amount_cents, currency, valid_from, valid_to, priority, vehicle_type FROM old;
