-- H-04 HTX field inspection before shift start.
-- Append-only log per booking. The latest row decides, and it counts as a pass only while the farmer readiness
-- sequence and the package window still match the values stored when the HTX recorded it. Any later readiness
-- edit or applied postponement therefore needs a fresh inspection. Readiness rows are not changed here.
-- Existing unstarted packages have no row and need a PASSED inspection before start. Started shifts keep running.
-- ponytail: no photos, geometry or evidence references yet. Upgrade: attach evidence once the H-04 UI rules are approved.

ALTER TABLE dispatch.package_bookings ADD CONSTRAINT package_bookings_booking_package UNIQUE (booking_id, package_id);

CREATE TABLE dispatch.field_inspections (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  package_id UUID NOT NULL,
  reviewer_id UUID NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASSED', 'FAILED')),
  reason TEXT CHECK (reason IS NULL OR (btrim(reason) <> '' AND char_length(reason) <= 500)),
  readiness_sequence BIGINT NOT NULL REFERENCES dispatch.readiness_events (sequence),
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT field_inspections_reason_for_fail CHECK ((result = 'FAILED') = (reason IS NOT NULL)),
  CONSTRAINT field_inspections_window_order CHECK (window_end_at > window_start_at),
  CONSTRAINT field_inspections_membership FOREIGN KEY (booking_id, package_id)
    REFERENCES dispatch.package_bookings (booking_id, package_id)
);

CREATE INDEX field_inspections_booking_idx ON dispatch.field_inspections (booking_id, sequence);

CREATE TRIGGER field_inspections_no_update BEFORE UPDATE ON dispatch.field_inspections
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER field_inspections_no_delete BEFORE DELETE ON dispatch.field_inspections
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

-- Inspections freeze once the package has a shift, same as readiness.
CREATE FUNCTION dispatch.guard_inspection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dispatch.shifts s WHERE s.package_id = NEW.package_id) THEN
    RAISE EXCEPTION 'HTX inspection is frozen after shift start' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER field_inspections_guard_insert BEFORE INSERT ON dispatch.field_inspections
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_inspection_insert();

-- Database backstop for the app gate: no shift row can exist unless every booking has a current pass.
-- NOT COALESCE keeps NULL (no inspection, or no readiness) on the refusing side.
CREATE FUNCTION dispatch.guard_shift_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM dispatch.package_bookings pb
      JOIN dispatch.packages ip ON ip.id = pb.package_id
      LEFT JOIN LATERAL (
        SELECT i.result, i.readiness_sequence, i.window_start_at, i.window_end_at
          FROM dispatch.field_inspections i
         WHERE i.booking_id = pb.booking_id
         ORDER BY i.sequence DESC LIMIT 1) li ON true
     WHERE pb.package_id = NEW.package_id
       AND NOT COALESCE(li.result = 'PASSED'
         AND li.readiness_sequence = (SELECT max(r.sequence) FROM dispatch.readiness_events r WHERE r.booking_id = pb.booking_id)
         AND li.window_start_at = ip.window_start_at AND li.window_end_at = ip.window_end_at, false)) THEN
    RAISE EXCEPTION 'shift start needs a current HTX pass' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shifts_guard_inspection BEFORE INSERT ON dispatch.shifts
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_shift_inspection();
