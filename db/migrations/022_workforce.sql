-- Workforce self-reports, independent review metadata, recruitment requirements, and external wage acknowledgments.
-- No identity documents, KYC claims, payment processing, service settlement, or historic inferred values.
CREATE TABLE dispatch.operator_profiles (
  operator_id UUID PRIMARY KEY,
  skills TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_profile_skills_count CHECK (cardinality(skills) <= 30),
  CONSTRAINT operator_profile_skills_valid CHECK (array_position(skills, '') IS NULL)
);
CREATE TABLE dispatch.operator_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  expires_on DATE NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_cert_review_marker CHECK ((verification_status = 'UNVERIFIED') = (reviewed_by IS NULL AND reviewed_at IS NULL))
);
CREATE INDEX operator_certifications_operator_idx ON dispatch.operator_certifications(operator_id, expires_on);

CREATE FUNCTION dispatch.guard_operator_certification_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM account.user_roles WHERE user_id=NEW.operator_id AND role='operator') THEN
    RAISE EXCEPTION 'operator role required' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operator_certification_insert_guard BEFORE INSERT ON dispatch.operator_certifications FOR EACH ROW EXECUTE FUNCTION dispatch.guard_operator_certification_insert();
CREATE FUNCTION dispatch.guard_operator_certification_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.operator_id,NEW.name,NEW.expires_on,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.operator_id,OLD.name,OLD.expires_on,OLD.created_at)
     OR OLD.verification_status <> 'UNVERIFIED' OR NEW.verification_status NOT IN ('VERIFIED','REJECTED')
     OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL
     OR NOT EXISTS(SELECT 1 FROM account.user_roles WHERE user_id=NEW.reviewed_by AND role='admin') THEN
    RAISE EXCEPTION 'certification review requires independent admin verification' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operator_certification_review_guard BEFORE UPDATE ON dispatch.operator_certifications FOR EACH ROW EXECUTE FUNCTION dispatch.guard_operator_certification_review();
CREATE TRIGGER operator_certifications_no_delete BEFORE DELETE ON dispatch.operator_certifications FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

CREATE FUNCTION dispatch.guard_operator_profile_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM account.user_roles WHERE user_id=NEW.operator_id AND role='operator') THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operator_profile_insert_guard BEFORE INSERT ON dispatch.operator_profiles FOR EACH ROW EXECUTE FUNCTION dispatch.guard_operator_profile_insert();
CREATE FUNCTION dispatch.guard_operator_profile_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operator_id IS DISTINCT FROM OLD.operator_id THEN RAISE EXCEPTION 'profile owner immutable' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operator_profile_owner_guard BEFORE UPDATE ON dispatch.operator_profiles FOR EACH ROW EXECUTE FUNCTION dispatch.guard_operator_profile_update();
CREATE TRIGGER operator_profiles_no_delete BEFORE DELETE ON dispatch.operator_profiles FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();

ALTER TABLE dispatch.jobs ADD COLUMN wage_type TEXT CHECK (wage_type IS NULL OR wage_type IN ('PER_HA', 'PER_SHIFT', 'NEGOTIABLE'));
ALTER TABLE dispatch.jobs ADD COLUMN wage_amount_vnd BIGINT CHECK (wage_amount_vnd IS NULL OR wage_amount_vnd > 0);
ALTER TABLE dispatch.jobs ADD COLUMN machine_type TEXT CHECK (machine_type IS NULL OR machine_type IN ('harvester', 'tractor', 'drone'));
ALTER TABLE dispatch.jobs ADD COLUMN required_skills TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE dispatch.jobs ADD CONSTRAINT jobs_required_skills_count CHECK (cardinality(required_skills) <= 30);
ALTER TABLE dispatch.jobs ADD CONSTRAINT jobs_wage_amount_pair CHECK ((wage_amount_vnd IS NULL) OR wage_type IN ('PER_HA', 'PER_SHIFT'));
CREATE FUNCTION dispatch.guard_job_workforce_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.wage_type,NEW.wage_amount_vnd,NEW.machine_type,NEW.required_skills) IS DISTINCT FROM ROW(OLD.wage_type,OLD.wage_amount_vnd,OLD.machine_type,OLD.required_skills) THEN
    RAISE EXCEPTION 'recruitment details immutable after creation' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER jobs_workforce_fields_immutable BEFORE UPDATE ON dispatch.jobs FOR EACH ROW EXECUTE FUNCTION dispatch.guard_job_workforce_update();

CREATE TABLE dispatch.shift_wage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL UNIQUE REFERENCES dispatch.shifts(id),
  operator_id UUID NOT NULL,
  provider_id UUID NOT NULL,
  reported_by UUID NOT NULL,
  amount_vnd BIGINT NOT NULL CHECK (amount_vnd > 0),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500)),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shift_wage_report_parties CHECK (operator_id <> provider_id),
  CONSTRAINT shift_wage_reporter_party CHECK (reported_by = provider_id)
);
CREATE TABLE dispatch.shift_wage_acknowledgments (
  report_id UUID NOT NULL REFERENCES dispatch.shift_wage_reports(id),
  actor_id UUID NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, actor_id)
);
CREATE FUNCTION dispatch.guard_shift_wage_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD;
BEGIN
  SELECT sh.status, p.operator_id, p.provider_id INTO s
    FROM dispatch.shifts sh JOIN dispatch.packages p ON p.id=sh.package_id WHERE sh.id=NEW.shift_id;
  IF NOT FOUND OR s.status <> 'COMPLETED' OR NEW.operator_id IS DISTINCT FROM s.operator_id OR NEW.provider_id IS DISTINCT FROM s.provider_id THEN
    RAISE EXCEPTION 'wage report requires completed shift and assigned participants' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER shift_wage_report_guard BEFORE INSERT ON dispatch.shift_wage_reports FOR EACH ROW EXECUTE FUNCTION dispatch.guard_shift_wage_report();
CREATE TRIGGER shift_wage_report_no_update BEFORE UPDATE OR DELETE ON dispatch.shift_wage_reports FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
CREATE FUNCTION dispatch.guard_shift_wage_ack() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  SELECT operator_id, provider_id, reported_by INTO r FROM dispatch.shift_wage_reports WHERE id=NEW.report_id;
  IF NOT FOUND OR NEW.actor_id NOT IN (r.operator_id, r.provider_id) OR NEW.actor_id = r.reported_by THEN
    RAISE EXCEPTION 'only other assigned participant can acknowledge wage report' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER shift_wage_ack_guard BEFORE INSERT ON dispatch.shift_wage_acknowledgments FOR EACH ROW EXECUTE FUNCTION dispatch.guard_shift_wage_ack();
CREATE TRIGGER shift_wage_ack_no_update BEFORE UPDATE OR DELETE ON dispatch.shift_wage_acknowledgments FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
