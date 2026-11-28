-- A deposit and a final payment cannot reserve the same money or reuse a transfer reference.
-- Keep existing immutable records even when a later acceptance is lower than prior transfers.
CREATE FUNCTION dispatch.guard_settlement_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ceiling BIGINT;
  reserved NUMERIC;
BEGIN
  -- Same booking lock as API writers; serialize the two ledgers before reading them.
  SELECT total_vnd INTO ceiling FROM dispatch.bookings WHERE id = NEW.booking_id FOR UPDATE;
  SELECT COALESCE((
    SELECT a.total_vnd FROM dispatch.acceptances a
    WHERE a.booking_id = NEW.booking_id AND (
      SELECT count(*) FROM dispatch.acceptance_consents c
      WHERE c.booking_id = a.booking_id AND c.version = a.version
    ) = 2
    ORDER BY a.version DESC LIMIT 1
  ), ceiling) INTO ceiling;

  IF (TG_TABLE_NAME = 'payments' AND EXISTS (
    SELECT 1 FROM dispatch.deposits WHERE booking_id = NEW.booking_id AND reference = NEW.reference
  )) OR (TG_TABLE_NAME = 'deposits' AND EXISTS (
    SELECT 1 FROM dispatch.payments WHERE booking_id = NEW.booking_id AND reference = NEW.reference
  )) THEN
    RAISE EXCEPTION 'transfer reference already used in other settlement ledger' USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT COALESCE((SELECT sum(amount_vnd) FROM dispatch.payments WHERE booking_id = NEW.booking_id), 0)
       + COALESCE((SELECT sum(amount_vnd) FROM dispatch.deposits WHERE booking_id = NEW.booking_id), 0)
    INTO reserved;
  IF reserved + NEW.amount_vnd > ceiling THEN
    RAISE EXCEPTION 'settlement claims exceed the applicable total' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard_settlement BEFORE INSERT ON dispatch.payments
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_settlement_claim();
CREATE TRIGGER deposits_guard_settlement BEFORE INSERT ON dispatch.deposits
  FOR EACH ROW EXECUTE FUNCTION dispatch.guard_settlement_claim();
