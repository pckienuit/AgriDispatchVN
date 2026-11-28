-- G6 recruitment: provider jobs, operator applications, provider offers and append-only history.
-- Provider and operator IDs are verified account IDs, so there are no identity foreign keys (same convention as 002).
-- Applications never consume capacity. Capacity is checked when an offer is accepted, under the job row lock.

CREATE TABLE dispatch.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 120),
  locality TEXT NOT NULL CHECK (btrim(locality) <> '' AND char_length(locality) <= 200),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_window_order CHECK (end_at > start_at),
  CONSTRAINT jobs_closed_marker CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

CREATE INDEX jobs_provider_created_idx ON dispatch.jobs (provider_id, created_at DESC, id DESC);
CREATE INDEX jobs_created_idx ON dispatch.jobs (created_at DESC, id DESC);

CREATE TABLE dispatch.applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES dispatch.jobs (id),
  operator_id UUID NOT NULL,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED', 'OFFERED', 'WITHDRAWN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT applications_job_operator_key UNIQUE (job_id, operator_id),
  CONSTRAINT applications_offer_target UNIQUE (id, job_id, operator_id)
);

CREATE INDEX applications_job_created_idx ON dispatch.applications (job_id, created_at DESC, id DESC);

CREATE TABLE dispatch.offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL,
  job_id UUID NOT NULL,
  operator_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offers_application_target FOREIGN KEY (application_id, job_id, operator_id)
    REFERENCES dispatch.applications (id, job_id, operator_id),
  CONSTRAINT offers_responded_marker CHECK ((status = 'OFFERED') = (responded_at IS NULL))
);

-- At most one live offer per application. Declined or withdrawn offers stay as history and do not block a re-offer.
CREATE UNIQUE INDEX offers_one_live_per_application ON dispatch.offers (application_id)
  WHERE status IN ('OFFERED', 'ACCEPTED');
CREATE INDEX offers_operator_created_idx ON dispatch.offers (operator_id, created_at DESC, id DESC);

CREATE TABLE dispatch.recruitment_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job', 'application', 'offer')),
  entity_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
  actor_id UUID NOT NULL,
  from_status TEXT CHECK (from_status IS NULL OR char_length(from_status) <= 20),
  to_status TEXT NOT NULL CHECK (char_length(to_status) BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX recruitment_events_entity_idx ON dispatch.recruitment_events (entity_type, entity_id, id);

CREATE FUNCTION dispatch.reject_recruitment_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch.recruitment_events is append-only';
END;
$$;

CREATE TRIGGER recruitment_events_append_only
  BEFORE UPDATE OR DELETE ON dispatch.recruitment_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.reject_recruitment_event_change();
