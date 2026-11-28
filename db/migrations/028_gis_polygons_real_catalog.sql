ALTER TABLE dispatch.fields
  ADD COLUMN boundary_geojson JSONB,
  ADD COLUMN centroid_lat DOUBLE PRECISION,
  ADD COLUMN centroid_lng DOUBLE PRECISION,
  ADD COLUMN calculated_area_m2 INTEGER,
  ADD COLUMN province_code TEXT CHECK (province_code ~ '^[A-Z0-9-]{2,32}$'),
  ADD COLUMN commune_code TEXT CHECK (commune_code ~ '^[A-Z0-9-]{2,32}$'),
  ADD CONSTRAINT fields_territory_code_pair CHECK ((province_code IS NULL) = (commune_code IS NULL)),
  ADD CONSTRAINT fields_geojson_metrics CHECK (
    (boundary_geojson IS NULL AND centroid_lat IS NULL AND centroid_lng IS NULL AND calculated_area_m2 IS NULL)
    OR ((jsonb_typeof(boundary_geojson) = 'object' AND boundary_geojson->>'type' = 'Polygon'
      AND centroid_lat BETWEEN -90 AND 90 AND centroid_lng BETWEEN -180 AND 180
      AND calculated_area_m2 = area_m2) IS TRUE)
  );

-- Match the lock order used by API saves: consent first, then field. The trigger also guards direct inserts.
CREATE FUNCTION dispatch.guard_field_geojson_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.boundary_geojson IS NOT NULL AND (TG_OP = 'INSERT'
    OR NEW.boundary_geojson IS DISTINCT FROM OLD.boundary_geojson OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    PERFORM 1 FROM dispatch.location_consents
    WHERE owner_id = NEW.owner_id AND withdrawn_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active location consent required' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fields_geojson_consent_guard
  BEFORE INSERT OR UPDATE OF boundary_geojson, owner_id ON dispatch.fields
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_field_geojson_consent();

CREATE OR REPLACE FUNCTION dispatch.withdraw_location_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    UPDATE dispatch.fields
    SET boundary = NULL, boundary_geojson = NULL, centroid_lat = NULL, centroid_lng = NULL,
        calculated_area_m2 = NULL, updated_at = now()
    WHERE owner_id = NEW.owner_id AND (boundary IS NOT NULL OR boundary_geojson IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- active and updated_at already exist. Seed rows keep their existing identity and label.
ALTER TABLE dispatch.services
  ADD COLUMN unit TEXT NOT NULL DEFAULT 'ha' CHECK (unit = 'ha'),
  ADD COLUMN machine_type TEXT CHECK (machine_type IN ('harvester', 'tractor', 'drone')),
  ADD COLUMN description TEXT CHECK (char_length(description) <= 1000),
  ADD COLUMN created_by_user_id UUID,
  ADD COLUMN updated_by_user_id UUID;
