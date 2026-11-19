-- H-08: HTX (coop) first-level mediation and independent admin escalation.
-- Existing pre-020 disputes default to ADMIN level so legacy open and closed cases keep working without rewriting rows.
ALTER TABLE dispatch.disputes
  ADD COLUMN mediation_level TEXT NOT NULL DEFAULT 'ADMIN' CHECK (mediation_level IN ('HTX', 'ADMIN')),
  ADD COLUMN escalated_at TIMESTAMPTZ,
  ADD COLUMN escalated_by UUID,
  ADD COLUMN escalation_reason TEXT CHECK (escalation_reason IS NULL OR (btrim(escalation_reason) <> '' AND char_length(escalation_reason) <= 2000)),
  ADD COLUMN escalation_conflict_type TEXT CHECK (
    escalation_conflict_type IS NULL
    OR escalation_conflict_type IN ('PARTY_CONFLICT', 'ROLE_OVERLAP', 'MACHINE_CONFLICT', 'AFFILIATION_CONFLICT', 'RECUSAL_REQUEST', 'PARTY_REQUEST')
  ),
  ADD CONSTRAINT disputes_escalation_consistency CHECK (
    (escalated_at IS NULL AND escalated_by IS NULL AND escalation_reason IS NULL AND escalation_conflict_type IS NULL)
    OR (escalated_at IS NOT NULL AND escalated_by IS NOT NULL AND escalation_reason IS NOT NULL AND mediation_level = 'ADMIN')
  );

ALTER TABLE dispatch.disputes ALTER COLUMN mediation_level SET DEFAULT 'HTX';

CREATE UNIQUE INDEX dispute_events_one_escalation
  ON dispatch.dispute_events (dispute_id)
  WHERE event_type = 'MEDIATION_ESCALATED';

ALTER TABLE dispatch.dispute_events DROP CONSTRAINT dispute_events_event_type_check;
ALTER TABLE dispatch.dispute_events
  ADD CONSTRAINT dispute_events_event_type_check CHECK (
    event_type IN ('DISPUTE_OPENED', 'RESPONSE_ADDED', 'MEDIATOR_ASSIGNED', 'MEDIATION_ESCALATED')
  );

CREATE OR REPLACE FUNCTION dispatch.guard_dispute_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking_owner UUID; booking_state TEXT; assigned_provider UUID;
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
    RAISE EXCEPTION 'dispute parties must be booking owner and assigned provider' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.respondent_id AND role IN ('farmer', 'provider', 'coop')) THEN
    RAISE EXCEPTION 'respondent needs a current party role' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.mediation_level IS DISTINCT FROM 'HTX'
     OR NEW.mediator_id IS NOT NULL
     OR NEW.escalated_at IS NOT NULL
     OR NEW.escalated_by IS NOT NULL
     OR NEW.escalation_reason IS NOT NULL
     OR NEW.escalation_conflict_type IS NOT NULL THEN
    RAISE EXCEPTION 'new dispute must start at HTX level without mediator or escalation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.guard_dispute_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'closed dispute is final' USING ERRCODE = 'restrict_violation';
  END IF;
  IF ROW(NEW.id, NEW.booking_id, NEW.claimant_id, NEW.respondent_id, NEW.reason, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.booking_id, OLD.claimant_id, OLD.respondent_id, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'dispute identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.mediation_level = 'ADMIN' AND NEW.mediation_level <> 'ADMIN' THEN
    RAISE EXCEPTION 'cannot downgrade mediation level' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.escalated_at IS NOT NULL AND ROW(NEW.escalated_at, NEW.escalated_by, NEW.escalation_reason, NEW.escalation_conflict_type)
     IS DISTINCT FROM ROW(OLD.escalated_at, OLD.escalated_by, OLD.escalation_reason, OLD.escalation_conflict_type) THEN
    RAISE EXCEPTION 'escalation audit is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.escalated_at IS DISTINCT FROM OLD.escalated_at THEN
    IF OLD.mediation_level <> 'HTX' OR NEW.mediation_level <> 'ADMIN'
       OR NEW.escalated_by IS NULL OR NEW.escalation_reason IS NULL OR NEW.mediator_id IS NOT NULL THEN
      RAISE EXCEPTION 'escalation requires HTX to ADMIN transition, audit fields, and unseated mediator' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM dispatch.dispute_events WHERE dispute_id = NEW.id AND event_type = 'MEDIATION_ESCALATED') THEN
      RAISE EXCEPTION 'escalation needs audit event' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.mediation_level IS DISTINCT FROM OLD.mediation_level THEN
    RAISE EXCEPTION 'mediation level change requires explicit escalation' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.mediator_id IS DISTINCT FROM OLD.mediator_id THEN
    IF NEW.mediator_id IS NULL THEN
      IF NOT (OLD.mediation_level = 'HTX' AND NEW.mediation_level = 'ADMIN' AND NEW.escalated_at IS NOT NULL) THEN
        RAISE EXCEPTION 'mediator cannot be unassigned' USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NEW.mediation_level = 'ADMIN' THEN
      IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.mediator_id AND role = 'admin') THEN
        RAISE EXCEPTION 'mediator must hold admin role' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.mediator_id IN (NEW.claimant_id, NEW.respondent_id) OR EXISTS (
        SELECT 1 FROM dispatch.bookings b
          LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
          LEFT JOIN dispatch.packages p ON p.id = pb.package_id
         WHERE b.id = NEW.booking_id
           AND NEW.mediator_id IN (b.owner_id, b.coordinator_id, p.coop_id, p.provider_id, p.operator_id)
      ) THEN
        RAISE EXCEPTION 'mediator must be independent' USING ERRCODE = 'restrict_violation';
      END IF;
    ELSE
      IF OLD.mediator_id IS NOT NULL THEN
        RAISE EXCEPTION 'htx mediator reassignment requires escalation' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.mediator_id AND role = 'coop') THEN
        RAISE EXCEPTION 'htx mediator must hold coop role' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM dispatch.bookings b
          LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
          LEFT JOIN dispatch.packages p ON p.id = pb.package_id
         WHERE b.id = NEW.booking_id AND NEW.mediator_id IN (b.coordinator_id, p.coop_id)
      ) THEN
        RAISE EXCEPTION 'htx mediator must have persisted relationship to case' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.mediator_id IN (NEW.claimant_id, NEW.respondent_id)
         OR EXISTS (
           SELECT 1 FROM dispatch.bookings b
             LEFT JOIN dispatch.package_bookings pb ON pb.booking_id = b.id
             LEFT JOIN dispatch.packages p ON p.id = pb.package_id
            WHERE b.id = NEW.booking_id AND NEW.mediator_id IN (b.owner_id, p.provider_id, p.operator_id)
         )
         OR EXISTS (SELECT 1 FROM account.user_roles WHERE user_id = NEW.mediator_id AND role IN ('provider', 'operator', 'admin'))
         OR EXISTS (SELECT 1 FROM dispatch.machines WHERE owner_id = NEW.mediator_id) THEN
        RAISE EXCEPTION 'htx mediator must be independent' USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'OPEN' THEN
    IF NEW.closed_at IS NOT NULL OR NEW.closure_reason IS NOT NULL THEN
      RAISE EXCEPTION 'open dispute has no closure' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.status NOT IN ('RESOLVED', 'CLOSED_UNRESOLVED') OR NEW.closed_at IS NULL OR NEW.closure_reason IS NULL THEN
    RAISE EXCEPTION 'explicit closure required' USING ERRCODE = 'restrict_violation';
  ELSIF NEW.status = 'CLOSED_UNRESOLVED' AND NEW.mediation_level <> 'ADMIN' THEN
    RAISE EXCEPTION 'unresolved closure requires admin level' USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.guard_dispute_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF NEW.event_type = 'MEDIATION_ESCALATED' THEN
    IF d.status <> 'OPEN' THEN
      RAISE EXCEPTION 'dispute is not open' USING ERRCODE = 'restrict_violation';
    END IF;
    IF d.mediation_level <> 'HTX'
       OR EXISTS (SELECT 1 FROM dispatch.dispute_events WHERE dispute_id = NEW.dispute_id AND event_type = 'MEDIATION_ESCALATED') THEN
      RAISE EXCEPTION 'dispute cannot be escalated again' USING ERRCODE = 'restrict_violation';
    END IF;
    IF keys IS DISTINCT FROM ARRAY['conflictType', 'previousMediatorId', 'reason'] THEN
      RAISE EXCEPTION 'escalation event data has an unexpected shape' USING ERRCODE = 'check_violation';
    END IF;
    IF jsonb_typeof(NEW.data->'reason') IS DISTINCT FROM 'string'
       OR btrim(NEW.data->>'reason') = '' OR char_length(NEW.data->>'reason') > 2000 THEN
      RAISE EXCEPTION 'escalation reason must be 1 to 2000 characters' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (jsonb_typeof(NEW.data->'conflictType') = 'null'
            OR (jsonb_typeof(NEW.data->'conflictType') = 'string'
                AND (NEW.data->>'conflictType') IN ('PARTY_CONFLICT', 'ROLE_OVERLAP', 'MACHINE_CONFLICT', 'AFFILIATION_CONFLICT', 'RECUSAL_REQUEST', 'PARTY_REQUEST'))) THEN
      RAISE EXCEPTION 'escalation conflict type is invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (jsonb_typeof(NEW.data->'previousMediatorId') = 'null'
            OR ((NEW.data->>'previousMediatorId') ~ uuid_pattern AND jsonb_typeof(NEW.data->'previousMediatorId') = 'string')) THEN
      RAISE EXCEPTION 'escalation previousMediatorId must be UUID or null' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.data->>'previousMediatorId') IS DISTINCT FROM d.mediator_id::text THEN
      RAISE EXCEPTION 'escalation previousMediatorId must match current mediator' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.check_mediator_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  latest_type TEXT;
  latest_mediator TEXT;
  current_row dispatch.disputes%ROWTYPE;
BEGIN
  SELECT event_type, data->>'mediatorId' INTO latest_type, latest_mediator
    FROM dispatch.dispute_events
   WHERE dispute_id = NEW.id AND event_type IN ('MEDIATOR_ASSIGNED', 'MEDIATION_ESCALATED')
   ORDER BY sequence DESC LIMIT 1;
  SELECT * INTO current_row FROM dispatch.disputes WHERE id = NEW.id;
  IF latest_type = 'MEDIATION_ESCALATED' THEN
    IF current_row.mediator_id IS NOT NULL OR current_row.mediation_level <> 'ADMIN' OR current_row.escalated_at IS NULL THEN
      RAISE EXCEPTION 'mediator change needs a matching audit event' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF latest_mediator IS DISTINCT FROM current_row.mediator_id::text THEN
    RAISE EXCEPTION 'mediator change needs a matching audit event' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch.check_mediator_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_row dispatch.disputes%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM dispatch.disputes WHERE id = NEW.dispute_id;
  IF NEW.event_type = 'MEDIATOR_ASSIGNED' THEN
    IF current_row.mediator_id::text IS DISTINCT FROM (NEW.data->>'mediatorId') THEN
      RAISE EXCEPTION 'mediator audit event does not match the dispute' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.event_type = 'MEDIATION_ESCALATED' THEN
    IF current_row.mediation_level <> 'ADMIN' OR current_row.escalated_at IS NULL
       OR current_row.escalated_by IS DISTINCT FROM NEW.actor_id
       OR current_row.escalation_reason IS DISTINCT FROM (NEW.data->>'reason')
       OR current_row.escalation_conflict_type IS DISTINCT FROM (NEW.data->>'conflictType')
       OR (current_row.mediator_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM dispatch.dispute_events
          WHERE dispute_id = NEW.dispute_id AND event_type = 'MEDIATOR_ASSIGNED' AND sequence > NEW.sequence
       )) THEN
      RAISE EXCEPTION 'escalation audit event does not match the dispute' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
