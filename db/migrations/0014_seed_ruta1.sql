-- Ruta 1: Villa Bonita – Centro (Guayaquil), según la especificación §7.
-- Se crea en BORRADOR: el equipo de rutas debe confirmar las coordenadas en terreno (location_verified),
-- ejecutar la validación con la API de mapas y publicarla con aprobación de una segunda persona.
-- El orden de paradas es el recorrido real confirmado por el propietario (decisiones §0).
-- Las coordenadas son APROXIMADAS y no están verificadas.
DO $$
DECLARE
  route_id uuid := gen_random_uuid();
  out_id   uuid := gen_random_uuid();
  in_id    uuid := gen_random_uuid();
  names    text[] := ARRAY['Villa Bonita', 'San Marino', 'Mall del Sol', 'City Mall', 'Riocentro Norte', 'Mall del Río',
                           'Parque Centenario', '9 de Octubre', 'Vélez', 'Chile y Colón', 'Bahía – Castillo'];
  refs     text[] := ARRAY['Origen (Vía a Daule)', 'Av. Francisco de Orellana', 'Av. Juan Tanca Marenco', 'Av. Benjamín Carrión',
                           'Av. Francisco de Orellana', 'Por confirmar ubicación exacta', 'Av. 9 de Octubre', 'Av. 9 de Octubre',
                           'Calle Vélez', 'Chile y Colón', 'Bahía, calle Castillo'];
  lats     numeric[] := ARRAY[-2.0950, -2.1690, -2.1550, -2.1395, -2.1460, -2.1750, -2.1890, -2.1920, -2.1930, -2.1975, -2.2000];
  lngs     numeric[] := ARRAY[-79.9480, -79.8990, -79.8925, -79.9080, -79.8960, -79.8900, -79.8890, -79.8850, -79.8815, -79.8820, -79.8800];
  ids      uuid[] := ARRAY[]::uuid[];
  n        int := array_length(names, 1);
BEGIN
  IF EXISTS (SELECT 1 FROM fixed_routes.routes WHERE code = 'R1') THEN RETURN; END IF;
  INSERT INTO fixed_routes.routes (id, code, name, status, corridor)
  VALUES (route_id, 'R1', 'Villa Bonita – Centro', 'draft',
          'Vía a Daule → Autopista Narcisa de Jesús → Av. Francisco de Orellana → Av. Juan Tanca Marenco → Av. de las Américas');
  INSERT INTO fixed_routes.directions (id, route_id, direction, label) VALUES
    (out_id, route_id, 'outbound', 'Villa Bonita → Centro'),
    (in_id, route_id, 'inbound', 'Centro → Villa Bonita (orden inverso provisional: revisar calles de un solo sentido en el Centro)');
  FOR i IN 1..n LOOP
    ids := ids || gen_random_uuid();
    INSERT INTO fixed_routes.stops (id, name, reference, lat, lng, location_verified) VALUES (ids[i], names[i], refs[i], lats[i], lngs[i], false);
    INSERT INTO fixed_routes.direction_stops (direction_id, stop_id, seq) VALUES (out_id, ids[i], i - 1);
  END LOOP;
  FOR i IN 1..n LOOP
    INSERT INTO fixed_routes.direction_stops (direction_id, stop_id, seq) VALUES (in_id, ids[n - i + 1], i - 1);
  END LOOP;
  -- Tarifa por persona, hora de Guayaquil al confirmar el abordaje: [06:30, 21:00) $3.00; [21:00, 06:30) $4.00.
  INSERT INTO fixed_routes.fare_rules (id, route_id, name, start_local, end_local, amount_cents) VALUES
    (gen_random_uuid(), route_id, 'Diurna', '06:30', '21:00', 300),
    (gen_random_uuid(), route_id, 'Nocturna', '21:00', '06:30', 400);
END $$;
