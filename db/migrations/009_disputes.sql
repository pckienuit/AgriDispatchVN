-- G8a booking disputes: open case, append-only party responses, independent mediator assignment.
-- A dispute is a claim between the booking owner and the assigned provider. It is not an arbitration decision.
-- No remedy, consent, refund, debt, settlement or timeout is modelled here. Closing a case is the G8b slice.
-- Evidence is not modelled yet. Blob references arrive with G9 once upload storage is designed.
-- ponytail: CLOSED rows are allowed by the CHECK so G8b and retention fixtures can insert closed history. No app route writes CLOSED here.
-- ponytail: mediator reassignment is audited by the app in the same transaction. The deferred trigger refuses a mismatch at commit.
-- ponytail: previousMediatorId is not checked against the prior row. Upgrade: compare it inside the mediator guard.

CREATE TABLE dispatch.disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  claimant_id UUID NOT NULL,
  respondent_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('AREA_MISMATCH', 'QUALITY', 'NO_SHOW', 'PAYMENT', 'OTHER')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  mediator_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT disputes_parties_distinct CHECK (claimant_id <> respondent_id)
);

-- At most one OPEN case per booking. Closed cases keep their rows and IDs.
CREATE UNIQUE INDEX disputes_one_open_per_booking ON dispatch.disputes (booking_id) WHERE status = 'OPEN';
CREATE INDEX disputes_booking_created_idx ON dispatch.disputes (booking_id, created_at, id);

CREATE TABLE dispatch.dispute_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES dispatch.disputes (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('DISPUTE_OPENED', 'RESPONSE_ADDED', 'MEDIATOR_ASSIGNED')),
  actor_id UUID NOT NULL,
  data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one opening event per dispute.
CREATE UNIQUE INDEX dispute_events_one_opening ON dispatch.dispute_events (dispute_id) WHERE event_type = 'DISPUTE_OPENED';
CREATE INDEX dispute_events_dispute_idx ON dispatch.dispute_events (dispute_id, sequence);

-- Opening needs a booking that is ASSIGNED with a provider. Parties are exactly the booking owner and that provider.
-- The respondent must hold farmer or provider role, so a read-only coop account cannot be a respondent.
CREATE FUNCTION dispatch.guard_dispute_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  booking_owner UUID;
  booking_state TEXT;
  assigned_provider UUID;
BEGIN
  SELECT bk.owner_id, bk.state, pk.provider_id INTO booking_owner, booking_state, assigned_provider
    FROM dispatch.bookings bk
    LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = bk.id
    LEFT JOIN dispatch.packages pk ON pk.id = pb.package_id
   WHERE bk.id = NEW.booking_id;
  IF booking_state IS DISTINCT FROM 'ASSIGNED' OR assigned_provider IS NULL THEN
    RAISE EXCEPTION 'dispute needs an assigned booking' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((NEW.claimant_id = booking_owner AND NEW.respondent_id = assigned_provider)
       OR (NEW.claimant_id = assigned_provider AND NEW.respondent_id = booking_owner)) THEN
    RAISE EXCEPTION 'dispute parties must be the booking owner and the assigned provider' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.respondent_id AND role IN ('farmer', 'provider')) THEN
    RAISE EXCEPTION 'respondent must be a farmer or provider party' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disputes_guard_insert BEFORE INSERT ON dispatch.disputes
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_dispute_insert();

-- While OPEN, only mediator_id may change. Identity, reason and status are fixed.
-- A mediator must hold the admin role and must not be a party or a known package participant.
CREATE FUNCTION dispatch.guard_dispute_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'closed dispute is final' USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.id, NEW.booking_id, NEW.claimant_id, NEW.respondent_id, NEW.reason, NEW.status, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.claimant_id, OLD.respondent_id, OLD.reason, OLD.status, OLD.created_at) THEN
    RAISE EXCEPTION 'only the mediator may change while a dispute is open' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.mediator_id IS DISTINCT FROM OLD.mediator_id THEN
    IF NEW.mediator_id IS NULL THEN
      RAISE EXCEPTION 'mediator cannot be unassigned' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.mediator_id AND role = 'admin') THEN
      RAISE EXCEPTION 'mediator must hold the admin role' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.mediator_id IN (NEW.claimant_id, NEW.respondent_id) OR EXISTS (
         SELECT 1 FROM dispatch.bookings bk
           LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = bk.id
           LEFT JOIN dispatch.packages pk ON pk.id = pb.package_id
          WHERE bk.id = NEW.booking_id
            AND NEW.mediator_id IN (bk.owner_id, bk.coordinator_id, pk.coop_id, pk.provider_id, pk.operator_id)) THEN
      RAISE EXCEPTION 'mediator must be independent of the parties' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER disputes_guard_update BEFORE UPDATE ON dispatch.disputes
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_dispute_update();
CREATE TRIGGER disputes_no_delete BEFORE DELETE ON dispatch.disputes
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

-- Each event row has a shape per type. Text is bounded to 2000 characters. Responses bind to the respondent.
CREATE FUNCTION dispatch.guard_dispute_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d dispatch.disputes%ROWTYPE;
  keys TEXT[];
  uuid_pattern TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(NEW.data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'dispute event data must be a JSON object' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM dispatch.disputes WHERE id = NEW.dispute_id;
  keys := ARRAY(SELECT k FROM jsonb_object_keys(NEW.data) AS k ORDER BY k);

  IF NEW.event_type = 'DISPUTE_OPENED' THEN
    IF NEW.actor_id IS DISTINCT FROM d.claimant_id THEN
      RAISE EXCEPTION 'only the claimant opens a dispute' USING ERRCODE = 'restrict_violation';
    END IF;
    IF keys IS DISTINCT FROM ARRAY['details', 'reason'] THEN
      RAISE EXCEPTION 'opening event data must hold reason and details only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.data->>'reason' IS DISTINCT FROM d.reason
       OR jsonb_typeof(NEW.data->'details') IS DISTINCT FROM 'string'
       OR btrim(NEW.data->>'details') = '' OR char_length(NEW.data->>'details') > 2000 THEN
      RAISE EXCEPTION 'opening event data does not match the dispute' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'RESPONSE_ADDED' THEN
    IF d.status <> 'OPEN' THEN
      RAISE EXCEPTION 'dispute is not open' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.actor_id IS DISTINCT FROM d.respondent_id THEN
      RAISE EXCEPTION 'only the respondent may respond' USING ERRCODE = 'restrict_violation';
    END IF;
    IF keys IS DISTINCT FROM ARRAY['text'] THEN
      RAISE EXCEPTION 'response data must hold text only' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW.data->'text') IS DISTINCT FROM 'string'
       OR btrim(NEW.data->>'text') = '' OR char_length(NEW.data->>'text') > 2000 THEN
      RAISE EXCEPTION 'response text must be 1 to 2000 characters' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'MEDIATOR_ASSIGNED' THEN
    IF d.status <> 'OPEN' THEN
      RAISE EXCEPTION 'dispute is not open' USING ERRCODE = 'restrict_violation';
    END IF;
    IF keys IS DISTINCT FROM ARRAY['mediatorId', 'previousMediatorId'] THEN
      RAISE EXCEPTION 'mediator event data has an unexpected shape' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW.data->'mediatorId') IS DISTINCT FROM 'string' OR (NEW.data->>'mediatorId') !~ uuid_pattern
       OR NOT (jsonb_typeof(NEW.data->'previousMediatorId') = 'null'
               OR ((NEW.data->>'previousMediatorId') ~ uuid_pattern AND jsonb_typeof(NEW.data->'previousMediatorId') = 'string')) THEN
      RAISE EXCEPTION 'mediator event IDs must be UUIDs' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dispute_events_guard_insert BEFORE INSERT ON dispatch.dispute_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_dispute_event_insert();
CREATE TRIGGER dispute_events_no_update BEFORE UPDATE ON dispatch.dispute_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER dispute_events_no_delete BEFORE DELETE ON dispatch.dispute_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

-- Deferred audit: at commit the current mediator must equal the latest MEDIATOR_ASSIGNED event, in both directions.
CREATE FUNCTION dispatch.check_mediator_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest TEXT;
  current_mediator UUID;
BEGIN
  SELECT data->>'mediatorId' INTO latest FROM dispatch.dispute_events
   WHERE dispute_id = NEW.id AND event_type = 'MEDIATOR_ASSIGNED' ORDER BY sequence DESC LIMIT 1;
  SELECT mediator_id INTO current_mediator FROM dispatch.disputes WHERE id = NEW.id;
  IF latest IS DISTINCT FROM current_mediator::text THEN
    RAISE EXCEPTION 'mediator change needs a matching audit event' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION dispatch.check_mediator_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type = 'MEDIATOR_ASSIGNED' THEN
    IF (SELECT mediator_id FROM dispatch.disputes WHERE id = NEW.dispute_id)::text IS DISTINCT FROM (NEW.data->>'mediatorId') THEN
      RAISE EXCEPTION 'mediator audit event does not match the dispute' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER disputes_mediator_audit AFTER UPDATE OF mediator_id ON dispatch.disputes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.check_mediator_audit();
CREATE CONSTRAINT TRIGGER dispute_events_mediator_audit AFTER INSERT ON dispatch.dispute_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.check_mediator_event();
