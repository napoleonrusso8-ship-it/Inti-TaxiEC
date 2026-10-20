-- 13: una sola app para pasajeros y socios. Al registrarse, el socio elige su tipo:
-- conductor de taxi, dueño de taxi amarillo para Taxi Ruta, dueño de furgoneta (Taxi Ruta),
-- empresa de alquiler de autos u operador de grúa.
ALTER TABLE drivers.profiles
  ADD COLUMN partner_kind text NOT NULL DEFAULT 'taxi_driver'
    CHECK (partner_kind IN ('taxi_driver', 'route_taxi_owner', 'van_owner', 'rental_company', 'tow_operator')),
  -- Empresa de alquiler: razón social y RUC (cifrado + índice ciego para unicidad + versión enmascarada).
  ADD COLUMN business_name text,
  ADD COLUMN ruc_enc bytea,
  ADD COLUMN ruc_hmac bytea UNIQUE,
  ADD COLUMN ruc_masked text;

-- La empresa de alquiler no necesita licencia profesional; los demás tipos sí.
ALTER TABLE drivers.profiles
  ALTER COLUMN license_number_enc DROP NOT NULL,
  ALTER COLUMN license_number_hmac DROP NOT NULL,
  ALTER COLUMN license_number_masked DROP NOT NULL,
  ALTER COLUMN license_category DROP NOT NULL,
  ALTER COLUMN license_expires_on DROP NOT NULL;
ALTER TABLE drivers.profiles ADD CONSTRAINT profiles_partner_requirements CHECK (
  CASE WHEN partner_kind = 'rental_company'
    THEN business_name IS NOT NULL AND ruc_enc IS NOT NULL AND ruc_hmac IS NOT NULL AND ruc_masked IS NOT NULL
    ELSE license_number_enc IS NOT NULL AND license_number_hmac IS NOT NULL AND license_number_masked IS NOT NULL
      AND license_category IS NOT NULL AND license_expires_on IS NOT NULL
  END
);

-- Nuevo documento personal: certificado del RUC (empresa de alquiler).
ALTER TABLE drivers.documents DROP CONSTRAINT documents_type_check;
ALTER TABLE drivers.documents ADD CONSTRAINT documents_type_check CHECK (type IN ('license', 'background_check', 'company_ruc', 'registration', 'insurance'));
