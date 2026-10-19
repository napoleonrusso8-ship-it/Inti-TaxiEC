-- Módulo 3: onboarding de conductores + roles de administración (RBAC).
CREATE SCHEMA IF NOT EXISTS admin;

-- Roles con expiración opcional; nunca se borran (se revocan) para conservar la trazabilidad.
CREATE TABLE admin.role_assignments (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo')),
  granted_by  uuid,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  revoked_by  uuid
);
CREATE UNIQUE INDEX role_assignments_active_uniq ON admin.role_assignments (user_id, role) WHERE revoked_at IS NULL;

CREATE SCHEMA IF NOT EXISTS drivers;

CREATE TABLE drivers.profiles (
  user_id               uuid PRIMARY KEY,
  status                text NOT NULL DEFAULT 'applicant' CHECK (status IN ('applicant', 'under_review', 'approved', 'rejected', 'suspended')),
  license_number_enc    bytea NOT NULL,
  license_number_hmac   bytea NOT NULL UNIQUE,
  license_number_masked text NOT NULL,
  license_category      text NOT NULL,
  license_expires_on    date NOT NULL,
  risk_flags            text[] NOT NULL DEFAULT '{}',
  submitted_at          timestamptz,
  decided_by            uuid,
  decided_at            timestamptz,
  decision_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers.vehicles (
  id               uuid PRIMARY KEY,
  driver_id        uuid NOT NULL REFERENCES drivers.profiles (user_id),
  plate            text NOT NULL UNIQUE CHECK (plate ~ '^[A-Z]{3}-[0-9]{3,4}$'),
  make             text NOT NULL,
  model            text NOT NULL,
  year             integer NOT NULL,
  color            text NOT NULL,
  seats_passenger  integer NOT NULL CHECK (seats_passenger BETWEEN 1 AND 8),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_driver_idx ON drivers.vehicles (driver_id);

CREATE TABLE drivers.documents (
  id                uuid PRIMARY KEY,
  driver_id         uuid NOT NULL REFERENCES drivers.profiles (user_id),
  vehicle_id        uuid REFERENCES drivers.vehicles (id),
  type              text NOT NULL CHECK (type IN ('license', 'background_check', 'registration', 'insurance')),
  storage_key       text NOT NULL UNIQUE,
  content_type      text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes        integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256            bytea NOT NULL,
  upload_status     text NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'uploaded', 'rejected')),
  scan_status       text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'invalid')),
  expires_on        date,
  review_status     text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  rejection_reason  text,
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((type IN ('registration', 'insurance')) = (vehicle_id IS NOT NULL))
);
CREATE INDEX documents_driver_idx ON drivers.documents (driver_id) WHERE superseded_at IS NULL;
