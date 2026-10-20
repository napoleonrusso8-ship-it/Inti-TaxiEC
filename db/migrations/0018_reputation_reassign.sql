-- 12C: calificaciones con etiquetas (ambos sentidos) y reasignación de unidad (máximo 5).
ALTER TABLE trips.ratings ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 6);

ALTER TABLE trips.trips ADD COLUMN reassign_count integer NOT NULL DEFAULT 0 CHECK (reassign_count BETWEEN 0 AND 5);
-- Taxi Ruta: cambios de unidad de una reserva.
ALTER TABLE fixed_routes.bookings ADD COLUMN switch_count integer NOT NULL DEFAULT 0 CHECK (switch_count BETWEEN 0 AND 5);

-- Estado "reasignando": el viaje vuelve a buscar conductor excluyendo a los anteriores.
-- (Se reutiliza 'matching'; los conductores ya ofrecidos quedan excluidos por trips.offers.)
ALTER TABLE trips.offers DROP CONSTRAINT offers_status_check;
ALTER TABLE trips.offers ADD CONSTRAINT offers_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'superseded', 'reassigned'));
