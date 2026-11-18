-- Private dispute image references. Originals are immutable; no client-supplied URL or object name.
CREATE TABLE dispatch.evidence (
  id UUID PRIMARY KEY,
  dispute_id UUID NOT NULL REFERENCES dispatch.disputes(id),
  uploader_id UUID NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','UPLOADED','FAILED')),
  content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png')),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 4096),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  object_key TEXT NOT NULL UNIQUE CHECK(object_key ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}$'),
  etag TEXT CHECK(char_length(etag) BETWEEN 1 AND 256),
  blob_version TEXT CHECK(char_length(blob_version) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  uploaded_at TIMESTAMPTZ,
  CHECK((status='UPLOADED')=(uploaded_at IS NOT NULL AND etag IS NOT NULL)),
  CHECK(status='UPLOADED' OR (uploaded_at IS NULL AND etag IS NULL AND blob_version IS NULL))
);
CREATE INDEX evidence_case_idx ON dispatch.evidence(dispute_id,created_at,id);
CREATE UNIQUE INDEX evidence_dedupe_idx ON dispatch.evidence(dispute_id,uploader_id,sha256) WHERE status IN ('PENDING','UPLOADED');
CREATE FUNCTION dispatch.guard_evidence_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status<>'PENDING' OR NOT EXISTS(SELECT 1 FROM dispatch.disputes d
    WHERE d.id=NEW.dispute_id AND d.status='OPEN' AND NEW.uploader_id IN(d.claimant_id,d.respondent_id)) THEN
    RAISE EXCEPTION 'evidence requires open case party' USING ERRCODE='restrict_violation';
  END IF;
  IF NEW.object_key<>NEW.dispute_id::text||'/'||NEW.id::text||'/'||NEW.sha256 THEN
    RAISE EXCEPTION 'invalid evidence object identity' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION dispatch.guard_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('UPLOADED','FAILED')
    OR (to_jsonb(NEW)-'status'-'uploaded_at'-'etag'-'blob_version') IS DISTINCT FROM
       (to_jsonb(OLD)-'status'-'uploaded_at'-'etag'-'blob_version') THEN
    RAISE EXCEPTION 'evidence is immutable after upload attempt' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_guard_insert BEFORE INSERT ON dispatch.evidence FOR EACH ROW EXECUTE FUNCTION dispatch.guard_evidence_insert();
CREATE TRIGGER evidence_guard_update BEFORE UPDATE ON dispatch.evidence FOR EACH ROW EXECUTE FUNCTION dispatch.guard_evidence_update();
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON dispatch.evidence FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_append_only();
