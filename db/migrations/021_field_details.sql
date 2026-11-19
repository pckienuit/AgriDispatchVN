-- Farmer field boundary, access details, consent and optional harvest facts.
-- Coordinates are cleared when owner withdraws explicit consent.
ALTER TABLE dispatch.fields
  ADD COLUMN boundary JSONB,
  ADD COLUMN access_details JSONB NOT NULL DEFAULT '{"roadWidthM":null,"bridgeLoadT":null,"soil":null,"hasBoatDock":null}'::jsonb;

CREATE TABLE dispatch.location_consents (
  owner_id UUID PRIMARY KEY,
  version TEXT NOT NULL CHECK (version = 'field-boundary-v1'),
  granted_at TIMESTAMPTZ NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);

ALTER TABLE dispatch.bookings
  ADD COLUMN crop_variety TEXT CHECK (crop_variety IS NULL OR (btrim(crop_variety) <> '' AND char_length(crop_variety) <= 80)),
  ADD COLUMN sow_date DATE,
  ADD COLUMN harvest_date DATE,
  ADD CONSTRAINT bookings_harvest_date_order CHECK (sow_date IS NULL OR harvest_date IS NULL OR harvest_date >= sow_date);

CREATE FUNCTION dispatch.guard_field_boundary_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.boundary IS DISTINCT FROM OLD.boundary AND NEW.boundary IS NOT NULL
     AND current_setting('app.location_consent_withdrawal', true) IS DISTINCT FROM NEW.owner_id::text
     AND NOT EXISTS (SELECT 1 FROM dispatch.location_consents c WHERE c.owner_id = NEW.owner_id AND c.withdrawn_at IS NULL) THEN
    RAISE EXCEPTION 'active location consent required' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fields_boundary_consent_guard BEFORE UPDATE OF boundary ON dispatch.fields
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_field_boundary_consent();

CREATE FUNCTION dispatch.withdraw_location_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    PERFORM set_config('app.location_consent_withdrawal', NEW.owner_id::text, true);
    UPDATE dispatch.fields SET boundary = NULL, updated_at = now() WHERE owner_id = NEW.owner_id AND boundary IS NOT NULL;
    PERFORM set_config('app.location_consent_withdrawal', '', true);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER location_consent_withdraw AFTER UPDATE OF withdrawn_at ON dispatch.location_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.withdraw_location_consent();

CREATE FUNCTION dispatch.forbid_location_consent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'location consent record cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'location consent owner is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.withdrawn_at IS NULL AND (NEW.version IS DISTINCT FROM OLD.version OR NEW.granted_at IS DISTINCT FROM OLD.granted_at) THEN
    RAISE EXCEPTION 'active location consent grant is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
     AND NOT (NEW.withdrawn_at IS NULL AND NEW.granted_at > OLD.granted_at) THEN
    RAISE EXCEPTION 'location consent withdrawal is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER location_consents_guard BEFORE UPDATE OR DELETE ON dispatch.location_consents
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_location_consent_mutation();

CREATE INDEX fields_boundary_present_idx ON dispatch.fields (owner_id) WHERE boundary IS NOT NULL;
