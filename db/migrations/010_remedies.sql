-- Negotiated text proposals do not execute refunds, debt or transfers.
ALTER TABLE dispatch.disputes DROP CONSTRAINT disputes_status_check;
ALTER TABLE dispatch.disputes ADD CONSTRAINT disputes_status_check CHECK (status IN ('OPEN','CLOSED','RESOLVED','CLOSED_UNRESOLVED'));
ALTER TABLE dispatch.disputes ADD COLUMN closed_at TIMESTAMPTZ, ADD COLUMN closure_reason TEXT CHECK (char_length(closure_reason) BETWEEN 1 AND 2000);
CREATE OR REPLACE FUNCTION dispatch.guard_dispute_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'closed dispute is final' USING ERRCODE='restrict_violation'; END IF;
  IF ROW(NEW.id,NEW.booking_id,NEW.claimant_id,NEW.respondent_id,NEW.reason,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.booking_id,OLD.claimant_id,OLD.respondent_id,OLD.reason,OLD.created_at) THEN
    RAISE EXCEPTION 'dispute identity is immutable' USING ERRCODE='restrict_violation';
  END IF;
  IF NEW.mediator_id IS DISTINCT FROM OLD.mediator_id THEN
    IF NEW.mediator_id IS NULL OR NOT EXISTS(SELECT 1 FROM account.user_roles WHERE user_id=NEW.mediator_id AND role='admin') THEN
      RAISE EXCEPTION 'mediator must hold admin role' USING ERRCODE='restrict_violation';
    END IF;
    IF NEW.mediator_id IN(NEW.claimant_id,NEW.respondent_id) OR EXISTS(
      SELECT 1 FROM dispatch.bookings b LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
      LEFT JOIN dispatch.packages p ON p.id=pb.package_id WHERE b.id=NEW.booking_id
      AND NEW.mediator_id IN(b.owner_id,b.coordinator_id,p.coop_id,p.provider_id,p.operator_id)) THEN
      RAISE EXCEPTION 'mediator must be independent' USING ERRCODE='restrict_violation';
    END IF;
  END IF;
  IF NEW.status='OPEN' THEN
    IF NEW.closed_at IS NOT NULL OR NEW.closure_reason IS NOT NULL THEN
      RAISE EXCEPTION 'open dispute has no closure' USING ERRCODE='restrict_violation';
    END IF;
  ELSIF NEW.status NOT IN('RESOLVED','CLOSED_UNRESOLVED') OR NEW.closed_at IS NULL OR NEW.closure_reason IS NULL THEN
    RAISE EXCEPTION 'explicit closure required' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TABLE dispatch.remedy_proposals (
  dispute_id UUID NOT NULL REFERENCES dispatch.disputes(id),
  version INTEGER NOT NULL CHECK(version>0),
  mediator_id UUID NOT NULL,
  text TEXT NOT NULL CHECK(btrim(text)<>'' AND char_length(text)<=2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(dispute_id,version)
);
CREATE TABLE dispatch.remedy_consents (
  dispute_id UUID NOT NULL,
  version INTEGER NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(dispute_id,version,actor_id),
  FOREIGN KEY(dispute_id,version) REFERENCES dispatch.remedy_proposals(dispute_id,version)
);
CREATE TABLE dispatch.remedy_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES dispatch.disputes(id),
  actor_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN('PROPOSED','CONSENTED','RESOLVED','CLOSED_UNRESOLVED')),
  version INTEGER,
  details TEXT CHECK(char_length(details)<=2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER remedy_proposals_no_change BEFORE UPDATE OR DELETE ON dispatch.remedy_proposals FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER remedy_consents_no_change BEFORE UPDATE OR DELETE ON dispatch.remedy_consents FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER remedy_events_no_change BEFORE UPDATE OR DELETE ON dispatch.remedy_events FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE FUNCTION dispatch.check_remedy_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v INTEGER; m UUID;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT version,mediator_id INTO v,m FROM dispatch.remedy_proposals WHERE dispute_id=NEW.id ORDER BY version DESC LIMIT 1;
    IF NEW.status='RESOLVED' AND (v IS NULL OR m IS DISTINCT FROM NEW.mediator_id OR
       NOT EXISTS(SELECT 1 FROM dispatch.remedy_consents WHERE dispute_id=NEW.id AND version=v AND actor_id=NEW.claimant_id) OR
       NOT EXISTS(SELECT 1 FROM dispatch.remedy_consents WHERE dispute_id=NEW.id AND version=v AND actor_id=NEW.respondent_id)) THEN
      RAISE EXCEPTION 'resolution needs both parties on current proposal' USING ERRCODE='restrict_violation';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM dispatch.remedy_events WHERE dispute_id=NEW.id AND event_type=NEW.status) THEN
      RAISE EXCEPTION 'closure needs audit event' USING ERRCODE='restrict_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER disputes_remedy_closure AFTER UPDATE OF status ON dispatch.disputes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.check_remedy_closure();
