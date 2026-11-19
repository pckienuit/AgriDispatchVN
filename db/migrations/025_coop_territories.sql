-- Admin-managed commune assignments. Names and codes are entered by administrators, not a national directory.
CREATE TABLE dispatch.commune_territories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coop_id UUID NOT NULL,
  province_code TEXT NOT NULL CHECK (province_code ~ '^[A-Z0-9-]{2,32}$'),
  province_name TEXT NOT NULL CHECK (btrim(province_name) <> '' AND char_length(province_name) <= 120),
  commune_code TEXT NOT NULL CHECK (commune_code ~ '^[A-Z0-9-]{2,32}$'),
  commune_name TEXT NOT NULL CHECK (btrim(commune_name) <> '' AND char_length(commune_name) <= 120),
  assigned_by UUID NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by UUID,
  CONSTRAINT commune_territory_removal_pair CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX commune_territory_active_pair_idx ON dispatch.commune_territories (coop_id, province_code, commune_code) WHERE removed_at IS NULL;


CREATE TABLE dispatch.coop_territory_audit (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ASSIGNED', 'REMOVED')),
  actor_id UUID NOT NULL,
  province_code TEXT NOT NULL,
  province_name TEXT NOT NULL,
  commune_code TEXT NOT NULL,
  commune_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX coop_territory_audit_assignment_idx ON dispatch.coop_territory_audit (assignment_id, sequence);

CREATE FUNCTION dispatch.audit_commune_territory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO dispatch.coop_territory_audit (assignment_id, action, actor_id, province_code, province_name, commune_code, commune_name)
    VALUES (NEW.id, 'ASSIGNED', NEW.assigned_by, NEW.province_code, NEW.province_name, NEW.commune_code, NEW.commune_name);
  ELSIF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    IF ROW(NEW.id, NEW.coop_id, NEW.province_code, NEW.province_name, NEW.commune_code, NEW.commune_name, NEW.assigned_by, NEW.assigned_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.coop_id, OLD.province_code, OLD.province_name, OLD.commune_code, OLD.commune_name, OLD.assigned_by, OLD.assigned_at)
       OR NEW.removed_by IS NULL THEN
      RAISE EXCEPTION 'territory identity is immutable and removal actor is required' USING ERRCODE = 'restrict_violation';
    END IF;
    INSERT INTO dispatch.coop_territory_audit (assignment_id, action, actor_id, province_code, province_name, commune_code, commune_name)
    VALUES (NEW.id, 'REMOVED', NEW.removed_by, NEW.province_code, NEW.province_name, NEW.commune_code, NEW.commune_name);
  ELSE
    RAISE EXCEPTION 'territory records are immutable except one removal' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commune_territory_audit_trigger
  AFTER INSERT OR UPDATE ON dispatch.commune_territories
  FOR EACH ROW EXECUTE FUNCTION dispatch.audit_commune_territory();

CREATE FUNCTION dispatch.forbid_commune_territory_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'territory assignment history is immutable' USING ERRCODE = 'restrict_violation'; END;
$$;
CREATE TRIGGER commune_territory_no_delete BEFORE DELETE ON dispatch.commune_territories
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_commune_territory_delete();
CREATE TRIGGER commune_territory_no_truncate BEFORE TRUNCATE ON dispatch.commune_territories
  FOR EACH STATEMENT EXECUTE FUNCTION dispatch.forbid_commune_territory_delete();

CREATE FUNCTION dispatch.forbid_territory_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'territory audit is append-only' USING ERRCODE = 'restrict_violation'; END;
$$;
CREATE TRIGGER coop_territory_audit_no_update BEFORE UPDATE OR DELETE ON dispatch.coop_territory_audit
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_territory_audit_mutation();
