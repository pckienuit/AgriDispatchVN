-- G5a coordinator delegation and manual package grouping.
-- coordinator_id is a verified account ID with the coop role. The role lookup runs in the app against
-- account.user_roles (deliberate one-DB demo dependency), so there is no identity foreign key (same as 002 and 004).
-- ponytail: manual grouping only, no fees, radius, capacity or ha thresholds. Upgrade: grouping rules once the project agrees them.

-- Booking state moves REQUESTED -> GROUPED only. A grouped booking must name its coordinator.
ALTER TABLE dispatch.bookings DROP CONSTRAINT bookings_state_check;
ALTER TABLE dispatch.bookings
  ADD COLUMN coordinator_id UUID,
  ADD CONSTRAINT bookings_state_check CHECK (state IN ('REQUESTED', 'GROUPED')),
  ADD CONSTRAINT bookings_grouped_has_coordinator CHECK (state = 'REQUESTED' OR coordinator_id IS NOT NULL);

-- Replace the blanket update guard. Snapshot columns stay frozen; only state and coordinator_id may change.
-- Coordinator changes need REQUESTED; state moves only REQUESTED -> GROUPED.
DROP TRIGGER bookings_no_update ON dispatch.bookings;

CREATE FUNCTION dispatch.guard_booking_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.owner_id, NEW.field_id, NEW.service_id, NEW.start_at, NEW.end_at, NEW.field_name,
         NEW.field_area_m2, NEW.service_code, NEW.service_name, NEW.service_data_label,
         NEW.price_per_ha_vnd, NEW.total_vnd, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.owner_id, OLD.field_id, OLD.service_id, OLD.start_at, OLD.end_at, OLD.field_name,
         OLD.field_area_m2, OLD.service_code, OLD.service_name, OLD.service_data_label,
         OLD.price_per_ha_vnd, OLD.total_vnd, OLD.created_at) THEN
    RAISE EXCEPTION 'booking snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state = 'REQUESTED' AND NEW.state = 'GROUPED') THEN
    RAISE EXCEPTION 'invalid booking state transition' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.coordinator_id IS DISTINCT FROM OLD.coordinator_id AND OLD.state <> 'REQUESTED' THEN
    RAISE EXCEPTION 'coordinator is fixed after grouping' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_guard_update BEFORE UPDATE ON dispatch.bookings
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_booking_update();

-- Events: coordinator assignment keeps REQUESTED, grouping moves to GROUPED. The pairing rule keeps them aligned.
ALTER TABLE dispatch.booking_events
  DROP CONSTRAINT booking_events_event_type_check,
  DROP CONSTRAINT booking_events_to_state_check,
  ADD CONSTRAINT booking_events_type_known CHECK (event_type IN ('BOOKING_REQUESTED', 'COORDINATOR_ASSIGNED', 'BOOKING_GROUPED')),
  ADD CONSTRAINT booking_events_state_known CHECK (to_state IN ('REQUESTED', 'GROUPED')),
  ADD CONSTRAINT booking_events_type_state CHECK ((event_type = 'BOOKING_GROUPED') = (to_state = 'GROUPED'));

-- A package stores the shared interval, service, locality and coop. Status values beyond OPEN are used by the next slice.
CREATE TABLE dispatch.packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id UUID NOT NULL,
  service_id UUID NOT NULL REFERENCES dispatch.services (id),
  locality TEXT NOT NULL CHECK (btrim(locality) <> '' AND char_length(locality) <= 200),
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLAIMED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT packages_window_order CHECK (window_end_at > window_start_at)
);

CREATE INDEX packages_coop_created_idx ON dispatch.packages (coop_id, created_at DESC, id DESC);
CREATE INDEX packages_created_idx ON dispatch.packages (created_at DESC, id DESC);

-- UNIQUE(booking_id): a booking joins at most one package until cancellation is designed in a later slice.
CREATE TABLE dispatch.package_bookings (
  package_id UUID NOT NULL REFERENCES dispatch.packages (id),
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  PRIMARY KEY (package_id, booking_id),
  CONSTRAINT package_bookings_one_package UNIQUE (booking_id)
);
