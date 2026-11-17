-- G7a field readiness and operator shift execution.
-- Readiness flags are user confirmations kept as an append-only log. They are not agronomic thresholds or legal validation.
-- Shift state: RUNNING <-> PAUSED, RUNNING -> COMPLETED. Completion stores area and note only; no payment or settlement state.
-- Booking state stays ASSIGNED after completion. Package status stays CLAIMED.
-- ponytail: no WORK_COMPLETED booking state until the settlement design lands. Upgrade: add it with its own trigger rule and events.

CREATE FUNCTION dispatch.forbid_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only history: changes refused' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TABLE dispatch.shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL UNIQUE REFERENCES dispatch.packages (id),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  area_m2 INTEGER CHECK (area_m2 > 0),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500)),
  CONSTRAINT shifts_completion CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL AND area_m2 IS NOT NULL)),
  CONSTRAINT shifts_open_has_no_result CHECK (status = 'COMPLETED' OR (completed_at IS NULL AND area_m2 IS NULL AND note IS NULL))
);

CREATE FUNCTION dispatch.guard_shift_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.package_id, NEW.started_at) IS DISTINCT FROM ROW(OLD.id, OLD.package_id, OLD.started_at) THEN
    RAISE EXCEPTION 'shift identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed shift is final' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'RUNNING' AND NEW.status IN ('PAUSED', 'COMPLETED')) OR
    (OLD.status = 'PAUSED' AND NEW.status = 'RUNNING')) THEN
    RAISE EXCEPTION 'invalid shift state transition' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shifts_guard_update BEFORE UPDATE ON dispatch.shifts
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_shift_update();
CREATE TRIGGER shifts_no_delete BEFORE DELETE ON dispatch.shifts
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE TABLE dispatch.shift_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id UUID NOT NULL REFERENCES dispatch.shifts (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('SHIFT_STARTED', 'SHIFT_PAUSED', 'SHIFT_RESUMED', 'SHIFT_COMPLETED')),
  from_state TEXT CHECK (from_state IN ('RUNNING', 'PAUSED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('RUNNING', 'PAUSED', 'COMPLETED')),
  reason TEXT CHECK (reason IS NULL OR (btrim(reason) <> '' AND char_length(reason) <= 500)),
  area_m2 INTEGER CHECK (area_m2 > 0),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500)),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shift_events_transition CHECK (
    (event_type = 'SHIFT_STARTED' AND from_state IS NULL AND to_state = 'RUNNING') OR
    (event_type = 'SHIFT_PAUSED' AND from_state = 'RUNNING' AND to_state = 'PAUSED') OR
    (event_type = 'SHIFT_RESUMED' AND from_state = 'PAUSED' AND to_state = 'RUNNING') OR
    (event_type = 'SHIFT_COMPLETED' AND from_state = 'RUNNING' AND to_state = 'COMPLETED')),
  CONSTRAINT shift_events_reason_only_on_pause CHECK ((event_type = 'SHIFT_PAUSED') = (reason IS NOT NULL)),
  CONSTRAINT shift_events_area_only_on_completion CHECK ((event_type = 'SHIFT_COMPLETED') = (area_m2 IS NOT NULL))
);

CREATE INDEX shift_events_shift_idx ON dispatch.shift_events (shift_id, sequence);
CREATE TRIGGER shift_events_no_update BEFORE UPDATE ON dispatch.shift_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER shift_events_no_delete BEFORE DELETE ON dispatch.shift_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

-- A started shift blocks package cancellation, including scheduling cancel. The app route must still return a clean 409 (parent slice).
CREATE FUNCTION dispatch.guard_package_cancel_with_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id = NEW.id) THEN
    RAISE EXCEPTION 'package with a shift cannot be cancelled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER packages_guard_cancel_with_shift BEFORE UPDATE OF status ON dispatch.packages
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_package_cancel_with_shift();

-- Readiness is an append-only log per booking. The latest row is the current confirmation.
CREATE TABLE dispatch.readiness_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  actor_id UUID NOT NULL,
  drained BOOLEAN NOT NULL,
  mature BOOLEAN NOT NULL,
  intake_ready BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX readiness_events_booking_idx ON dispatch.readiness_events (booking_id, sequence);

CREATE FUNCTION dispatch.guard_readiness_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM dispatch.package_bookings pb
      JOIN dispatch.shifts s ON s.package_id = pb.package_id
     WHERE pb.booking_id = NEW.booking_id) THEN
    RAISE EXCEPTION 'readiness is frozen after shift start' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER readiness_events_guard_insert BEFORE INSERT ON dispatch.readiness_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_readiness_insert();
CREATE TRIGGER readiness_events_no_update BEFORE UPDATE ON dispatch.readiness_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER readiness_events_no_delete BEFORE DELETE ON dispatch.readiness_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
