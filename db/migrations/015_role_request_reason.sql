-- PostgreSQL CHECK accepts UNKNOWN; rejected requests must explicitly require a non-null reason.
ALTER TABLE account.role_requests DROP CONSTRAINT role_requests_reason_rule;
ALTER TABLE account.role_requests ADD CONSTRAINT role_requests_reason_rule CHECK (
  (status='REJECTED' AND decision_reason IS NOT NULL AND char_length(btrim(decision_reason)) BETWEEN 1 AND 500)
  OR (status<>'REJECTED' AND decision_reason IS NULL)
);
