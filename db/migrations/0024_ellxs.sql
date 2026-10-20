-- 13: "Modo Ella" pasa a llamarse "Modo Ellxs": viajes para mujeres y personas LGBTI, con conductorxs
-- mujeres o LGBTI aprobadxs por una persona del equipo.
-- La autodeclaración es un único booleano a propósito: NO revela si la persona es mujer o LGBTI.
-- Es un dato sensible (LOPDP art. 26): solo se guarda con un consentimiento explícito y versionado ('ellxs').
ALTER TABLE people.passenger_profiles RENAME COLUMN self_identifies_woman TO ellxs_member;

ALTER TABLE drivers.profiles RENAME COLUMN women_rides_requested_at TO ellxs_requested_at;
ALTER TABLE drivers.profiles RENAME COLUMN women_rides_approved_at TO ellxs_approved_at;
ALTER TABLE drivers.profiles RENAME COLUMN women_rides_approved_by TO ellxs_approved_by;

ALTER TABLE trips.trips RENAME COLUMN women_only TO ellxs_only;

-- Texto de consentimiento (BORRADOR: requiere revisión legal antes de producción).
INSERT INTO kyc.consent_texts (purpose, version, title, body, sha256) VALUES
('ellxs', 1, 'Modo Ellxs: autodeclaración',
 'BORRADOR — REQUIERE REVISIÓN LEGAL. Al activar Modo Ellxs declaras que eres mujer o que formas parte de la comunidad LGBTI. No te preguntamos a cuál de los dos grupos perteneces y no guardamos ese detalle: solo guardamos que activaste Modo Ellxs. Este dato es sensible (LOPDP art. 26) y lo usamos ÚNICAMENTE para permitirte pedir viajes con conductorxs Ellxs aprobadxs. Nunca se muestra a quien conduce ni se comparte con terceros. Puedes retirarlo cuando quieras desactivando Modo Ellxs en Ajustes > Preferencias: en ese momento se borra la autodeclaración. Tienes derecho de acceso, rectificación, eliminación, oposición y portabilidad escribiendo a privacidad@intitaxi.ec.', '');
UPDATE kyc.consent_texts SET sha256 = encode(sha256(convert_to(title || E'\n' || body, 'UTF8')), 'hex') WHERE purpose = 'ellxs' AND sha256 = '';
