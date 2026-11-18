-- Role requests: a farmer asks for provider, operator or coop. Admin decides. Admin is never requestable.
-- Decided rows are immutable history; only PENDING rows may change, and only their decision fields.
ALTER TABLE account.user_roles ADD COLUMN granted_by uuid REFERENCES account.users (id);
ALTER TABLE account.user_roles ADD CONSTRAINT user_roles_granter_not_self CHECK (granted_by IS NULL OR granted_by <> user_id);

CREATE TABLE account.role_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES account.users (id),
  requested_role text NOT NULL CONSTRAINT role_requests_requestable_role CHECK (requested_role IN ('provider', 'operator', 'coop')),
  status text NOT NULL DEFAULT 'PENDING' CONSTRAINT role_requests_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES account.users (id),
  decision_reason text,
  CONSTRAINT role_requests_pending_undecided CHECK (
    status <> 'PENDING' OR (decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL)
  ),
  CONSTRAINT role_requests_decided_by_other CHECK (
    status = 'PENDING' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decided_by <> user_id)
  ),
  CONSTRAINT role_requests_reason_rule CHECK (
    (status = 'REJECTED' AND char_length(decision_reason) BETWEEN 1 AND 500)
    OR (status <> 'REJECTED' AND decision_reason IS NULL)
  )
);

-- At most one open request per user and role. Concurrent duplicates fail here even if the app check races.
CREATE UNIQUE INDEX role_requests_one_pending ON account.role_requests (user_id, requested_role) WHERE status = 'PENDING';

-- Blocks DELETE and TRUNCATE outright, and any UPDATE of a decided row or of identity columns.
CREATE FUNCTION account.role_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'role request history is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'decided role request is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.requested_role IS DISTINCT FROM OLD.requested_role OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'role request identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_requests_guard_update BEFORE UPDATE ON account.role_requests
  FOR EACH ROW EXECUTE FUNCTION account.role_requests_guard();
CREATE TRIGGER role_requests_guard_delete BEFORE DELETE ON account.role_requests
  FOR EACH ROW EXECUTE FUNCTION account.role_requests_guard();
CREATE TRIGGER role_requests_guard_truncate BEFORE TRUNCATE ON account.role_requests
  FOR EACH STATEMENT EXECUTE FUNCTION account.role_requests_guard();
