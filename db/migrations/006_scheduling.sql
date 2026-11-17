-- Claims and cancellations retain history. Resource locks are shared by every schedule writer.
ALTER TABLE dispatch.packages
  ADD COLUMN provider_id UUID,
  ADD COLUMN machine_id UUID REFERENCES dispatch.machines(id),
  ADD COLUMN operator_id UUID,
  ADD COLUMN cancellation_reason TEXT CHECK (char_length(cancellation_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT packages_assignment_complete CHECK (
    (provider_id IS NULL AND machine_id IS NULL AND operator_id IS NULL)
    OR (provider_id IS NOT NULL AND machine_id IS NOT NULL AND operator_id IS NOT NULL)),
  ADD CONSTRAINT packages_claim_requires_assignment CHECK (status <> 'CLAIMED' OR provider_id IS NOT NULL);

ALTER TABLE dispatch.bookings DROP CONSTRAINT bookings_state_check;
ALTER TABLE dispatch.bookings ADD CONSTRAINT bookings_state_check CHECK (state IN ('REQUESTED','GROUPED','ASSIGNED','CANCELLED'));
CREATE OR REPLACE FUNCTION dispatch.guard_booking_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state' - 'coordinator_id') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'coordinator_id') THEN
    RAISE EXCEPTION 'booking snapshot is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'REQUESTED' AND NEW.state = 'GROUPED') OR
    (OLD.state = 'GROUPED' AND NEW.state IN ('ASSIGNED','CANCELLED')) OR
    (OLD.state = 'ASSIGNED' AND NEW.state = 'CANCELLED')) THEN
    RAISE EXCEPTION 'invalid booking state transition' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.coordinator_id IS DISTINCT FROM OLD.coordinator_id AND OLD.state <> 'REQUESTED' THEN
    RAISE EXCEPTION 'coordinator is fixed after grouping' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE dispatch.booking_events
  DROP CONSTRAINT booking_events_type_known,
  DROP CONSTRAINT booking_events_state_known,
  DROP CONSTRAINT booking_events_type_state,
  ADD CONSTRAINT booking_events_type_state CHECK (
    (event_type IN ('BOOKING_REQUESTED','COORDINATOR_ASSIGNED') AND to_state='REQUESTED') OR
    (event_type='BOOKING_GROUPED' AND to_state='GROUPED') OR
    (event_type='BOOKING_ASSIGNED' AND to_state='ASSIGNED') OR
    (event_type='BOOKING_CANCELLED' AND to_state='CANCELLED'));
CREATE TABLE dispatch.allocations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES dispatch.packages(id),
  resource_key TEXT NOT NULL CHECK (resource_key ~ '^(machine|operator):[0-9a-f-]{36}$'),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at),
  released_at TIMESTAMPTZ,
  UNIQUE(package_id,resource_key)
);
CREATE INDEX allocations_active_resource_idx ON dispatch.allocations(resource_key,start_at,end_at) WHERE released_at IS NULL;
-- ponytail: no btree_gist dependency until Azure extension availability is verified.
-- All API schedule writers hold transaction-scoped advisory locks per sorted resource key.
