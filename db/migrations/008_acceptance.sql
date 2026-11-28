-- G7b versioned booking acceptance and payer-reported external payment acknowledgments.
-- Proposals, consents, payments and payment events are append-only. Payment status is derived from events.
-- A payment row is a payer claim (REPORTED), not a verified transfer. No money moves and booking state does not change.
-- ponytail: agreed total is the proposal total. No surcharge, fee, deposit or VAT rule. Upgrade: versioned pricing rule once the project agrees it.
-- ponytail: no timeout, debt or reminder. Upgrade: settlement lifecycle in its own migration.

CREATE TABLE dispatch.acceptances (
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  proposer_id UUID NOT NULL,
  area_m2 INTEGER NOT NULL CHECK (area_m2 > 0),
  total_vnd BIGINT NOT NULL CHECK (total_vnd >= 0),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, version)
);

-- One row per party per version. The same actor cannot hold both parties on one version.
CREATE TABLE dispatch.acceptance_consents (
  booking_id UUID NOT NULL,
  version INTEGER NOT NULL,
  party TEXT NOT NULL CHECK (party IN ('owner', 'provider')),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, version, party),
  CONSTRAINT acceptance_consents_distinct_actor UNIQUE (booking_id, version, actor_id),
  CONSTRAINT acceptance_consents_version_fk FOREIGN KEY (booking_id, version)
    REFERENCES dispatch.acceptances (booking_id, version)
);

-- Payments bind to the agreed version. Reference is unique per booking; retries are matched in the app.
CREATE TABLE dispatch.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  acceptance_version INTEGER NOT NULL,
  payer_id UUID NOT NULL,
  amount_vnd BIGINT NOT NULL CHECK (amount_vnd > 0),
  reference TEXT NOT NULL CHECK (reference ~ '^[A-Za-z0-9._-]{4,64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_reference_key UNIQUE (booking_id, reference),
  CONSTRAINT payments_acceptance_fk FOREIGN KEY (booking_id, acceptance_version)
    REFERENCES dispatch.acceptances (booking_id, version)
);

-- Each payment has at most one REPORTED and one CONFIRMED event. confirmed_by and confirmed_at are the CONFIRMED row.
CREATE TABLE dispatch.payment_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES dispatch.payments (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('PAYMENT_REPORTED', 'PAYMENT_CONFIRMED')),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_once UNIQUE (payment_id, event_type)
);

-- Versions are consecutive. A fully consented version cannot be superseded. Proposal stays within booking limits.
CREATE FUNCTION dispatch.guard_acceptance_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest INTEGER;
  b RECORD;
BEGIN
  SELECT COALESCE(MAX(version), 0) INTO latest FROM dispatch.acceptances WHERE booking_id = NEW.booking_id;
  IF NEW.version <> latest + 1 THEN
    RAISE EXCEPTION 'acceptance version must follow the latest version' USING ERRCODE = 'restrict_violation';
  END IF;
  IF latest > 0 AND (SELECT COUNT(*) FROM dispatch.acceptance_consents c
                      WHERE c.booking_id = NEW.booking_id AND c.version = latest) = 2 THEN
    RAISE EXCEPTION 'fully consented acceptance cannot be superseded' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT field_area_m2, total_vnd INTO b FROM dispatch.bookings WHERE id = NEW.booking_id;
  IF NEW.area_m2 > b.field_area_m2 OR NEW.total_vnd > b.total_vnd THEN
    RAISE EXCEPTION 'acceptance exceeds booking limits' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A consent must bind the current version, so a superseded version cannot gain a signature.
CREATE FUNCTION dispatch.guard_consent_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> (SELECT MAX(version) FROM dispatch.acceptances WHERE booking_id = NEW.booking_id) THEN
    RAISE EXCEPTION 'consent must bind the current acceptance version' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Payments need both consents on the version they bind to. Claims cannot exceed the agreed total.
-- The app holds the booking row lock before insert, so concurrent claims cannot both read the old sum.
CREATE FUNCTION dispatch.guard_payment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agreed BIGINT;
BEGIN
  IF NEW.acceptance_version <> (SELECT MAX(version) FROM dispatch.acceptances WHERE booking_id = NEW.booking_id)
     OR (SELECT COUNT(*) FROM dispatch.acceptance_consents c
          WHERE c.booking_id = NEW.booking_id AND c.version = NEW.acceptance_version) <> 2 THEN
    RAISE EXCEPTION 'payment needs both consents on the current version' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT total_vnd INTO agreed FROM dispatch.acceptances
   WHERE booking_id = NEW.booking_id AND version = NEW.acceptance_version;
  IF NEW.amount_vnd + (SELECT COALESCE(SUM(amount_vnd), 0) FROM dispatch.payments WHERE booking_id = NEW.booking_id) > agreed THEN
    RAISE EXCEPTION 'payment claims exceed agreed total' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER acceptances_guard_insert BEFORE INSERT ON dispatch.acceptances
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_acceptance_insert();
CREATE TRIGGER acceptances_no_update BEFORE UPDATE ON dispatch.acceptances
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER acceptances_no_delete BEFORE DELETE ON dispatch.acceptances
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TRIGGER acceptance_consents_guard_insert BEFORE INSERT ON dispatch.acceptance_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_consent_insert();
CREATE TRIGGER acceptance_consents_no_update BEFORE UPDATE ON dispatch.acceptance_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER acceptance_consents_no_delete BEFORE DELETE ON dispatch.acceptance_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TRIGGER payments_guard_insert BEFORE INSERT ON dispatch.payments
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_payment_insert();
CREATE TRIGGER payments_no_update BEFORE UPDATE ON dispatch.payments
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON dispatch.payments
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON dispatch.payment_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON dispatch.payment_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
