-- Refuse deployment over corrupt historical assignments. Never rewrite signed/audited history.
LOCK TABLE dispatch.disputes, dispatch.dispute_events IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT data->>'previousMediatorId' AS recorded,
        lag(data->>'mediatorId') OVER (PARTITION BY dispute_id ORDER BY sequence) AS expected
      FROM dispatch.dispute_events WHERE event_type='MEDIATOR_ASSIGNED'
    ) history WHERE recorded IS DISTINCT FROM expected
  ) THEN
    RAISE EXCEPTION 'stored mediator history is inconsistent; operator review required' USING ERRCODE='check_violation';
  END IF;
END;
$$;
