-- Bind each mediator audit event to the prior event, not an arbitrary caller-supplied ID.
-- The dispute row lock serializes assignment history; existing applied migration bytes stay unchanged.
CREATE FUNCTION dispatch.guard_mediator_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id TEXT;
BEGIN
  IF NEW.event_type = 'MEDIATOR_ASSIGNED' THEN
    PERFORM 1 FROM dispatch.disputes WHERE id = NEW.dispute_id FOR UPDATE;
    SELECT data->>'mediatorId' INTO previous_id FROM dispatch.dispute_events
      WHERE dispute_id = NEW.dispute_id AND event_type = 'MEDIATOR_ASSIGNED'
      ORDER BY sequence DESC LIMIT 1;
    IF (NEW.data->>'previousMediatorId') IS DISTINCT FROM previous_id THEN
      RAISE EXCEPTION 'mediator history must match the prior assignment' USING ERRCODE='restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dispute_events_mediator_history BEFORE INSERT ON dispatch.dispute_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_mediator_history();
CREATE INDEX disputes_mediator_created_idx ON dispatch.disputes (mediator_id, created_at DESC, id DESC)
  WHERE mediator_id IS NOT NULL;
