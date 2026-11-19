-- Platform controls for the local demo. Parameters are explicit assumptions, not legal or pricing authority.
CREATE TABLE dispatch.platform_parameter_versions (
  version BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parameters JSONB NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
  changed_by UUID NOT NULL,
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dispatch.job_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES dispatch.jobs (id),
  reporter_id UUID NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWED', 'DISMISSED')),
  reviewed_by UUID,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_reports_review_marker CHECK ((status = 'OPEN') = (reviewed_by IS NULL AND reviewed_at IS NULL))
);
CREATE INDEX job_reports_queue_idx ON dispatch.job_reports (status, created_at DESC, id DESC);
CREATE INDEX job_reports_job_idx ON dispatch.job_reports (job_id, created_at DESC);

CREATE TABLE dispatch.platform_control_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('PARAMETERS_CHANGED', 'JOB_REPORT_REVIEWED', 'JOB_CLOSED')),
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION dispatch.reject_platform_control_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispatch.platform_control_events is append-only'; END $$;
CREATE TRIGGER platform_control_events_append_only
  BEFORE UPDATE OR DELETE ON dispatch.platform_control_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.reject_platform_control_event_change();
CREATE TRIGGER platform_parameter_versions_append_only
  BEFORE UPDATE OR DELETE ON dispatch.platform_parameter_versions
  FOR EACH ROW EXECUTE FUNCTION dispatch.reject_platform_control_event_change();
