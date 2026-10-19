-- Módulo 6: ruta GPS de cada viaje (base del manifiesto).
-- Retención: precisa 30 días (disputas); luego se seudonimiza (~110 m, minuto); se borra con el manifiesto (180 días).
-- Los viajes con incidente se conservan íntegros.
CREATE TABLE trips.trip_locations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id      uuid NOT NULL REFERENCES trips.trips (id),
  at           timestamptz NOT NULL,
  lat          numeric(9, 6) NOT NULL,
  lng          numeric(9, 6) NOT NULL,
  speed        real,
  heading      real,
  source       text NOT NULL CHECK (source IN ('driver', 'passenger', 'sos')),
  flags        text[] NOT NULL DEFAULT '{}',
  generalized  boolean NOT NULL DEFAULT false
);
CREATE INDEX trip_locations_trip_idx ON trips.trip_locations (trip_id, at);
