-- D5: HTX call confirmation on claimed packages and external deposit acknowledgment records.
-- No real money moves, no escrow, no bank validation, no arbitrary refund.
-- Hypothetical 10% deposit snapshot is derived server-side from booking total_vnd (round-half-up).
-- Telemetry (D6) and HTX commission estimates (D8/H-09) are read-only projections from existing tables.

CREATE TABLE dispatch.package_call_confirmations (
  package_id UUID PRIMARY KEY REFERENCES dispatch.packages (id),
  coop_id UUID NOT NULL,
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500)),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION dispatch.guard_package_call_confirmation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pkg RECORD;
BEGIN
  SELECT status, coop_id INTO pkg FROM dispatch.packages WHERE id = NEW.package_id;
  IF NOT FOUND OR pkg.status <> 'CLAIMED' THEN
    RAISE EXCEPTION 'htx call confirmation requires a claimed package' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.coop_id IS DISTINCT FROM pkg.coop_id THEN
    RAISE EXCEPTION 'only the assigned package coop can confirm call' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.coop_id AND role = 'coop') THEN
    RAISE EXCEPTION 'coop role required for package call confirmation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER package_call_confirmations_guard_insert BEFORE INSERT ON dispatch.package_call_confirmations
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_package_call_confirmation_insert();
CREATE TRIGGER package_call_confirmations_no_update BEFORE UPDATE ON dispatch.package_call_confirmations
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER package_call_confirmations_no_delete BEFORE DELETE ON dispatch.package_call_confirmations
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TABLE dispatch.deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES dispatch.bookings (id),
  package_id UUID NOT NULL REFERENCES dispatch.package_call_confirmations (package_id),
  payer_id UUID NOT NULL,
  payee_id UUID NOT NULL,
  booking_total_vnd BIGINT NOT NULL CHECK (booking_total_vnd > 0),
  deposit_rate_bps INTEGER NOT NULL DEFAULT 1000 CHECK (deposit_rate_bps = 1000),
  expected_deposit_vnd BIGINT NOT NULL CHECK (
    expected_deposit_vnd > 0
    AND expected_deposit_vnd = floor((booking_total_vnd::numeric + 5) / 10)::bigint
  ),
  amount_vnd BIGINT NOT NULL CHECK (amount_vnd = expected_deposit_vnd),
  reference TEXT NOT NULL CHECK (reference ~ '^[A-Za-z0-9._-]{4,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deposits_distinct_parties CHECK (payer_id <> payee_id),
  CONSTRAINT deposits_booking_package_fk FOREIGN KEY (booking_id, package_id)
    REFERENCES dispatch.package_bookings (booking_id, package_id)
);

CREATE INDEX deposits_package_idx ON dispatch.deposits (package_id, created_at);

CREATE FUNCTION dispatch.guard_deposit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pkg RECORD;
  bk RECORD;
BEGIN
  SELECT status, provider_id INTO pkg FROM dispatch.packages WHERE id = NEW.package_id;
  IF NOT FOUND OR pkg.status <> 'CLAIMED' OR pkg.provider_id IS NULL THEN
    RAISE EXCEPTION 'deposit requires a claimed package' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT state, owner_id, total_vnd INTO bk FROM dispatch.bookings WHERE id = NEW.booking_id;
  IF NOT FOUND OR bk.state <> 'ASSIGNED' THEN
    RAISE EXCEPTION 'deposit requires an assigned booking' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.payer_id IS DISTINCT FROM bk.owner_id THEN
    RAISE EXCEPTION 'deposit payer must be booking owner' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.payee_id IS DISTINCT FROM pkg.provider_id THEN
    RAISE EXCEPTION 'deposit payee must be assigned provider' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.booking_total_vnd IS DISTINCT FROM bk.total_vnd THEN
    RAISE EXCEPTION 'deposit snapshot must match booking total' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dispatch.disputes d
     WHERE d.booking_id = NEW.booking_id AND d.status IN ('OPEN', 'CLOSED_UNRESOLVED')
  ) THEN
    RAISE EXCEPTION 'open dispute blocks deposit write' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deposits_guard_insert BEFORE INSERT ON dispatch.deposits
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_deposit_insert();
CREATE TRIGGER deposits_no_update BEFORE UPDATE ON dispatch.deposits
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON dispatch.deposits
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TABLE dispatch.deposit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deposit_id UUID NOT NULL REFERENCES dispatch.deposits (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('DEPOSIT_REPORTED', 'DEPOSIT_CONFIRMED')),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deposit_events_once UNIQUE (deposit_id, event_type)
);

CREATE INDEX deposit_events_deposit_idx ON dispatch.deposit_events (deposit_id, id);

CREATE FUNCTION dispatch.guard_deposit_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  dep RECORD;
  pkg_status TEXT;
  bk_state TEXT;
BEGIN
  SELECT * INTO dep FROM dispatch.deposits WHERE id = NEW.deposit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deposit not found' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO pkg_status FROM dispatch.packages WHERE id = dep.package_id;
  SELECT state INTO bk_state FROM dispatch.bookings WHERE id = dep.booking_id;
  IF pkg_status IS DISTINCT FROM 'CLAIMED' OR bk_state IS DISTINCT FROM 'ASSIGNED' THEN
    RAISE EXCEPTION 'deposit event requires active claimed package and assigned booking' USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dispatch.disputes d
     WHERE d.booking_id = dep.booking_id AND d.status IN ('OPEN', 'CLOSED_UNRESOLVED')
  ) THEN
    RAISE EXCEPTION 'open dispute blocks deposit event' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.event_type = 'DEPOSIT_REPORTED' THEN
    IF NEW.actor_id IS DISTINCT FROM dep.payer_id THEN
      RAISE EXCEPTION 'only deposit payer can report transfer' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.event_type = 'DEPOSIT_CONFIRMED' THEN
    IF NEW.actor_id IS DISTINCT FROM dep.payee_id THEN
      RAISE EXCEPTION 'only deposit payee can confirm receipt' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM dispatch.deposit_events e
       WHERE e.deposit_id = NEW.deposit_id AND e.event_type = 'DEPOSIT_REPORTED'
    ) THEN
      RAISE EXCEPTION 'deposit report required before confirmation' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deposit_events_guard_insert BEFORE INSERT ON dispatch.deposit_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_deposit_event_insert();
CREATE TRIGGER deposit_events_no_update BEFORE UPDATE ON dispatch.deposit_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER deposit_events_no_delete BEFORE DELETE ON dispatch.deposit_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
