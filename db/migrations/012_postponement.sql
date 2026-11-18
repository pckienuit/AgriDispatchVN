-- Whole-package postponement: immutable versions, personal consents and application history.
-- Booking request/quote snapshots are deliberately untouched.
CREATE TABLE dispatch.postponement_proposals (
  package_id UUID NOT NULL REFERENCES dispatch.packages(id),
  version INTEGER NOT NULL CHECK (version > 0),
  old_start_at TIMESTAMPTZ NOT NULL,
  old_end_at TIMESTAMPTZ NOT NULL CHECK (old_end_at > old_start_at),
  start_at TIMESTAMPTZ NOT NULL CHECK (start_at > old_start_at),
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at AND end_at-start_at <= interval '30 days'),
  reason TEXT NOT NULL CHECK (btrim(reason) <> '' AND char_length(reason) <= 500),
  proposer_id UUID NOT NULL,
  required_actors UUID[] NOT NULL CHECK (cardinality(required_actors) BETWEEN 2 AND 101 AND array_position(required_actors,NULL) IS NULL),
  provider_id UUID NOT NULL,
  machine_id UUID NOT NULL REFERENCES dispatch.machines(id),
  operator_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(package_id,version)
);
CREATE TABLE dispatch.postponement_consents (
  package_id UUID NOT NULL,
  version INTEGER NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(package_id,version,actor_id),
  FOREIGN KEY(package_id,version) REFERENCES dispatch.postponement_proposals(package_id,version)
);
CREATE FUNCTION dispatch.guard_postponement_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dispatch.postponement_proposals p
    WHERE p.package_id=NEW.package_id AND p.version=NEW.version AND NEW.actor_id=ANY(p.required_actors)) THEN
    RAISE EXCEPTION 'consent requires actual party' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postponement_consents_guard BEFORE INSERT ON dispatch.postponement_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_postponement_consent();
CREATE TABLE dispatch.postponement_applications (
  package_id UUID NOT NULL,
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(package_id,version),
  FOREIGN KEY(package_id,version) REFERENCES dispatch.postponement_proposals(package_id,version)
);
CREATE FUNCTION dispatch.guard_postponement_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dispatch.postponement_proposals p
    WHERE p.package_id=NEW.package_id AND p.version=NEW.version
      AND cardinality(p.required_actors)=(SELECT count(*) FROM dispatch.postponement_consents c
        WHERE c.package_id=p.package_id AND c.version=p.version)) THEN
    RAISE EXCEPTION 'all personal consents required' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postponement_applications_guard BEFORE INSERT ON dispatch.postponement_applications
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_postponement_application();
CREATE TRIGGER postponement_proposals_no_update BEFORE UPDATE OR DELETE ON dispatch.postponement_proposals
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER postponement_consents_no_update BEFORE UPDATE OR DELETE ON dispatch.postponement_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE TRIGGER postponement_applications_no_update BEFORE UPDATE OR DELETE ON dispatch.postponement_applications
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE FUNCTION dispatch.guard_package_window_with_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.window_start_at,NEW.window_end_at) IS DISTINCT FROM ROW(OLD.window_start_at,OLD.window_end_at)
    AND EXISTS (SELECT 1 FROM dispatch.shifts WHERE package_id=NEW.id) THEN
    RAISE EXCEPTION 'package schedule frozen after shift start' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER packages_guard_window_with_shift BEFORE UPDATE OF window_start_at,window_end_at ON dispatch.packages
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_package_window_with_shift();
