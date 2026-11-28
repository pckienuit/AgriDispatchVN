-- No cross-service identity FK, consistent with dispatch.machines and dispatch.packages.
CREATE TABLE dispatch.provider_bank_accounts (
  provider_user_id UUID PRIMARY KEY,
  bank_bin TEXT NOT NULL CHECK (bank_bin ~ '^[0-9]{6}$'),
  bank_name TEXT NOT NULL CHECK (char_length(btrim(bank_name)) BETWEEN 1 AND 120),
  account_number TEXT NOT NULL CHECK (account_number ~ '^[A-Za-z0-9]{4,34}$'),
  account_holder TEXT NOT NULL CHECK (char_length(btrim(account_holder)) BETWEEN 1 AND 120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A hold can open before there is a transfer to report. Keep the existing deposit ledger immutable.
-- Historical deposits are intentionally not given a retroactive expiry.
CREATE TABLE dispatch.deposit_holds (
  booking_id UUID PRIMARY KEY REFERENCES dispatch.package_bookings (booking_id),
  deposit_expires_at TIMESTAMPTZ NOT NULL,
  deposit_expired_at TIMESTAMPTZ,
  release_reason TEXT,
  CONSTRAINT deposit_holds_expiry CHECK (
    (deposit_expired_at IS NULL AND release_reason IS NULL) OR
    (deposit_expired_at IS NOT NULL AND deposit_expired_at >= deposit_expires_at
      AND release_reason IS NOT NULL AND release_reason = 'DEPOSIT_EXPIRED'))
);

CREATE INDEX deposit_holds_due_idx ON dispatch.deposit_holds (deposit_expires_at) WHERE deposit_expired_at IS NULL;

-- Automated expiry has no human actor; keep actor attribution mandatory for all other events.
ALTER TABLE dispatch.booking_events ALTER COLUMN actor_id DROP NOT NULL,
  ADD CONSTRAINT booking_events_actor_kind CHECK ((actor_id IS NULL) = (event_type = 'BOOKING_DEPOSIT_EXPIRED')),
  DROP CONSTRAINT booking_events_type_state,
  ADD CONSTRAINT booking_events_type_state CHECK (
    (event_type IN ('BOOKING_REQUESTED','COORDINATOR_ASSIGNED') AND to_state = 'REQUESTED') OR
    (event_type = 'BOOKING_GROUPED' AND to_state = 'GROUPED') OR
    (event_type = 'BOOKING_ASSIGNED' AND to_state = 'ASSIGNED') OR
    (event_type IN ('BOOKING_CANCELLED','BOOKING_DEPOSIT_EXPIRED') AND to_state = 'CANCELLED'));

-- Serialize even direct ledger writes with the maintenance job and reject late receipt events.
CREATE FUNCTION dispatch.guard_deposit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  booking UUID;
BEGIN
  SELECT booking_id INTO booking FROM dispatch.deposits WHERE id = NEW.deposit_id;
  PERFORM 1 FROM dispatch.bookings WHERE id = booking FOR UPDATE;
  IF EXISTS (SELECT 1 FROM dispatch.deposit_holds WHERE booking_id = booking
      AND (deposit_expired_at IS NOT NULL OR deposit_expires_at <= clock_timestamp())) THEN
    RAISE EXCEPTION 'deposit window ended' USING ERRCODE = 'restrict_violation', CONSTRAINT = 'deposit_deadline';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deposit_events_guard_deadline BEFORE INSERT ON dispatch.deposit_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_deposit_deadline();

-- One definition for the current inspection, shared by API gates and the shift backstop.
CREATE FUNCTION dispatch.field_inspection_status(target_booking UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN i.readiness_sequence IS DISTINCT FROM (
           SELECT max(r.sequence) FROM dispatch.readiness_events r WHERE r.booking_id = pb.booking_id)
      OR i.window_start_at IS DISTINCT FROM p.window_start_at OR i.window_end_at IS DISTINCT FROM p.window_end_at
      THEN 'REQUIRED'
    WHEN i.result = 'PASSED' THEN 'PASSED'
    WHEN i.result = 'FAILED' THEN 'NOT_PASSED'
    ELSE 'REQUIRED'
  END
    FROM dispatch.package_bookings pb JOIN dispatch.packages p ON p.id = pb.package_id
    LEFT JOIN LATERAL (SELECT result, readiness_sequence, window_start_at, window_end_at
      FROM dispatch.field_inspections WHERE booking_id = pb.booking_id ORDER BY sequence DESC LIMIT 1) i ON true
   WHERE pb.booking_id = target_booking;
$$;

-- Keep history in the package, but only live bookings participate in a new shift.
CREATE OR REPLACE FUNCTION dispatch.guard_shift_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dispatch.package_bookings pb JOIN dispatch.bookings b ON b.id = pb.booking_id
      WHERE pb.package_id = NEW.package_id AND b.state = 'ASSIGNED') OR EXISTS (
    SELECT 1 FROM dispatch.package_bookings pb JOIN dispatch.bookings b ON b.id = pb.booking_id
     WHERE pb.package_id = NEW.package_id AND b.state = 'ASSIGNED'
       AND dispatch.field_inspection_status(b.id) IS DISTINCT FROM 'PASSED') THEN
    RAISE EXCEPTION 'shift start needs a current HTX pass' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Released deposit reports no longer consume settlement capacity. References remain immutable.
CREATE OR REPLACE FUNCTION dispatch.guard_settlement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ceiling BIGINT;
  reserved NUMERIC;
BEGIN
  SELECT total_vnd INTO ceiling FROM dispatch.bookings WHERE id = NEW.booking_id FOR UPDATE;
  SELECT COALESCE((
    SELECT a.total_vnd FROM dispatch.acceptances a
    WHERE a.booking_id = NEW.booking_id AND (
      SELECT count(*) FROM dispatch.acceptance_consents c
      WHERE c.booking_id = a.booking_id AND c.version = a.version
    ) = 2
    ORDER BY a.version DESC LIMIT 1
  ), ceiling) INTO ceiling;

  IF (TG_TABLE_NAME = 'payments' AND EXISTS (
    SELECT 1 FROM dispatch.deposits WHERE booking_id = NEW.booking_id AND reference = NEW.reference
  )) OR (TG_TABLE_NAME = 'deposits' AND EXISTS (
    SELECT 1 FROM dispatch.payments WHERE booking_id = NEW.booking_id AND reference = NEW.reference
  )) THEN
    RAISE EXCEPTION 'transfer reference already used in other settlement ledger' USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT COALESCE((SELECT sum(amount_vnd) FROM dispatch.payments WHERE booking_id = NEW.booking_id), 0)
       + COALESCE((SELECT sum(d.amount_vnd) FROM dispatch.deposits d
         LEFT JOIN dispatch.deposit_holds h USING (booking_id)
         WHERE d.booking_id = NEW.booking_id AND h.deposit_expired_at IS NULL), 0)
    INTO reserved;
  IF reserved + NEW.amount_vnd > ceiling THEN
    RAISE EXCEPTION 'settlement claims exceed the applicable total' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
