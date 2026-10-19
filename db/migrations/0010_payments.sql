-- Módulo 7: pagos. NUNCA se guardan datos de tarjeta (PAN, CVV): solo el token de la pasarela (cifrado),
-- marca y últimos 4 dígitos. Libro mayor de doble entrada, solo inserción.
CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE payments.payment_methods (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  gateway            text NOT NULL,
  gateway_ref_enc    bytea NOT NULL,
  brand              text NOT NULL,
  last4              text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month          smallint NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year           smallint NOT NULL,
  fingerprint_hmac   bytea,
  status             text NOT NULL CHECK (status IN ('pending_3ds', 'active', 'revoked')),
  three_ds_ref       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);
CREATE INDEX payment_methods_user_idx ON payments.payment_methods (user_id) WHERE status = 'active';
CREATE INDEX payment_methods_fp_idx ON payments.payment_methods (fingerprint_hmac);

CREATE TABLE payments.payments (
  id                 uuid PRIMARY KEY,
  trip_id            uuid NOT NULL REFERENCES trips.trips (id),
  payer_user_id      uuid NOT NULL,
  method             text NOT NULL CHECK (method IN ('cash', 'card', 'wallet')),
  payment_method_id  uuid REFERENCES payments.payment_methods (id),
  amount_cents       integer NOT NULL CHECK (amount_cents >= 0),
  currency           text NOT NULL DEFAULT 'USD',
  status             text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'cash_collected', 'refunded', 'partially_refunded')),
  gateway_ref        text,
  decline_reason     text,
  refunded_cents     integer NOT NULL DEFAULT 0,
  idempotency_key    text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_trip_idx ON payments.payments (trip_id);
CREATE INDEX payments_payer_idx ON payments.payments (payer_user_id, created_at DESC);

-- Libro mayor. Cuentas: gateway_clearing, platform_revenue, promo_expense, payouts_pending, bank_clearing,
-- driver_payable:{id} (lo que se le debe al conductor), wallet:{id} (crédito del pasajero).
CREATE TABLE payments.ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tx_id         uuid NOT NULL,
  account       text NOT NULL CHECK (account ~ '^(gateway_clearing|platform_revenue|promo_expense|payouts_pending|bank_clearing|refunds_issued|driver_payable:[0-9a-f-]{36}|wallet:[0-9a-f-]{36})$'),
  debit_cents   bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents  bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  kind          text NOT NULL,
  ref_type      text,
  ref_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);
CREATE INDEX ledger_account_idx ON payments.ledger_entries (account, id);
CREATE INDEX ledger_tx_idx ON payments.ledger_entries (tx_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON payments.ledger_entries FOR EACH ROW EXECUTE FUNCTION audit.forbid_mutation();

-- Cada transacción debe cuadrar (débitos = créditos). Se comprueba al confirmar la transacción de BD.
CREATE FUNCTION payments.check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0) INTO d, c FROM payments.ledger_entries WHERE tx_id = NEW.tx_id;
  IF d <> c THEN RAISE EXCEPTION 'asiento descuadrado (tx %, débitos %, créditos %)', NEW.tx_id, d, c; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON payments.ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments.check_balanced();

CREATE TABLE payments.payout_accounts (
  id                    uuid PRIMARY KEY,
  driver_id             uuid NOT NULL,
  bank_code             text NOT NULL,
  account_type          text NOT NULL CHECK (account_type IN ('savings', 'checking')),
  account_number_enc    bytea NOT NULL,
  account_number_masked text NOT NULL,
  holder_name_enc       bytea NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  usable_from           timestamptz NOT NULL,
  revoked_at            timestamptz
);
CREATE UNIQUE INDEX payout_accounts_one_active ON payments.payout_accounts (driver_id) WHERE revoked_at IS NULL;

CREATE TABLE payments.payouts (
  id                 uuid PRIMARY KEY,
  driver_id          uuid NOT NULL,
  payout_account_id  uuid NOT NULL REFERENCES payments.payout_accounts (id),
  amount_cents       integer NOT NULL CHECK (amount_cents > 0),
  status             text NOT NULL CHECK (status IN ('requested', 'under_review', 'processing', 'paid', 'rejected')),
  idempotency_key    text NOT NULL UNIQUE,
  review_reason      text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  processed_by       uuid
);
CREATE INDEX payouts_driver_idx ON payments.payouts (driver_id, requested_at DESC);

CREATE TABLE payments.fraud_signals (
  id            uuid PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('user', 'driver', 'trip', 'card', 'device')),
  subject_id    text NOT NULL,
  signal        text NOT NULL,
  score         integer NOT NULL CHECK (score BETWEEN 1 AND 100),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'confirmed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by   uuid,
  reviewed_at   timestamptz
);
CREATE INDEX fraud_subject_idx ON payments.fraud_signals (subject_type, subject_id) WHERE status = 'open';

-- Relación dispositivo ↔ cuenta (para detectar granjas de cuentas y colusión).
CREATE TABLE payments.device_accounts (
  device_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE payments.webhook_events (
  event_hash   bytea PRIMARY KEY,
  gateway      text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
