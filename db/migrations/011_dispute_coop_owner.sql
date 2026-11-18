-- A coop owning the booking is a party, unlike a coop merely coordinating somebody else's booking.
CREATE OR REPLACE FUNCTION dispatch.guard_dispute_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE booking_owner UUID; booking_state TEXT; assigned_provider UUID;
BEGIN
  SELECT bk.owner_id,bk.state,pk.provider_id INTO booking_owner,booking_state,assigned_provider
    FROM dispatch.bookings bk LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=bk.id
    LEFT JOIN dispatch.packages pk ON pk.id=pb.package_id WHERE bk.id=NEW.booking_id;
  IF booking_state IS DISTINCT FROM 'ASSIGNED' OR assigned_provider IS NULL THEN
    RAISE EXCEPTION 'dispute needs an assigned booking' USING ERRCODE='restrict_violation';
  END IF;
  IF NOT ((NEW.claimant_id=booking_owner AND NEW.respondent_id=assigned_provider)
       OR (NEW.claimant_id=assigned_provider AND NEW.respondent_id=booking_owner)) THEN
    RAISE EXCEPTION 'dispute parties must be booking owner and assigned provider' USING ERRCODE='restrict_violation';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM account.user_roles WHERE user_id=NEW.respondent_id AND role IN ('farmer','provider','coop')) THEN
    RAISE EXCEPTION 'respondent needs a current party role' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
