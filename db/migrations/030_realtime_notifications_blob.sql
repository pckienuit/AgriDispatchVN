CREATE TABLE dispatch.user_notifications (
  id BIGSERIAL PRIMARY KEY,
  recipient_user_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX user_notifications_recipient_idx ON dispatch.user_notifications (recipient_user_id, id DESC);
CREATE INDEX user_notifications_unread_idx ON dispatch.user_notifications (recipient_user_id, id DESC) WHERE read_at IS NULL;

-- ponytail: serialize notification ID allocation through commit, not domain writes. Most inserts
-- run in deferred triggers at commit. Without the lock, an earlier ID can commit after a stream
-- advanced past it. Upgrade to per-recipient cursors if measured commit contention warrants it.
CREATE FUNCTION dispatch.order_notification_inserts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(62431879);
  RETURN NULL;
END;
$$;
CREATE TRIGGER user_notifications_commit_order BEFORE INSERT ON dispatch.user_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION dispatch.order_notification_inserts();

CREATE FUNCTION dispatch.publish_user_notification(
  recipients UUID[], kind TEXT, entity TEXT, entity_key TEXT, heading TEXT, message TEXT, data JSONB
) RETURNS void LANGUAGE sql AS $$
  WITH inserted AS (
    INSERT INTO dispatch.user_notifications(recipient_user_id,event_type,entity_type,entity_id,title,body,payload)
    SELECT DISTINCT recipient, kind, entity, entity_key, heading, message, data
    FROM unnest(recipients) AS recipient WHERE recipient IS NOT NULL
    RETURNING recipient_user_id
  )
  SELECT pg_catalog.pg_notify('dispatch_user_notifications', recipient_user_id::text) FROM inserted;
$$;

-- Recipients are derived from committed domain records, never from input fields or a role-wide broadcast.
-- Only fixed copy and compact status/version data leave the domain tables.
CREATE FUNCTION dispatch.notify_domain_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipients UUID[];
  entity TEXT;
  entity_key UUID;
  kind TEXT;
  heading TEXT;
  data JSONB := '{}'::jsonb;
  package_key UUID;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'booking_events' THEN
      entity := 'booking'; entity_key := NEW.booking_id; kind := NEW.event_type; heading := 'Đơn dịch vụ có cập nhật';
      data := jsonb_build_object('state', NEW.to_state);
      SELECT ARRAY[b.owner_id,b.coordinator_id,p.coop_id,p.provider_id,p.operator_id] INTO recipients
        FROM dispatch.bookings b LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
        LEFT JOIN dispatch.packages p ON p.id=pb.package_id WHERE b.id=entity_key;
    WHEN 'packages' THEN
      entity := 'package'; entity_key := NEW.id; package_key := NEW.id; heading := 'Gói dịch vụ có cập nhật';
      kind := 'PACKAGE_' || NEW.status;
      IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN kind := 'PACKAGE_RESCHEDULED'; END IF;
      data := jsonb_build_object('status', NEW.status);
    WHEN 'shift_events' THEN
      entity := 'shift'; entity_key := NEW.shift_id; kind := NEW.event_type; heading := 'Ca làm có cập nhật';
      data := jsonb_build_object('status', NEW.to_state);
      SELECT s.package_id INTO package_key FROM dispatch.shifts s WHERE s.id=entity_key;
    WHEN 'acceptances', 'acceptance_consents' THEN
      entity := 'acceptance'; entity_key := NEW.booking_id; heading := 'Nghiệm thu có cập nhật';
      kind := CASE TG_TABLE_NAME WHEN 'acceptances' THEN 'ACCEPTANCE_PROPOSED' ELSE 'ACCEPTANCE_CONSENTED' END;
      data := jsonb_build_object('version', NEW.version);
      SELECT ARRAY[b.owner_id,b.coordinator_id,p.coop_id,p.provider_id] INTO recipients
        FROM dispatch.bookings b LEFT JOIN dispatch.package_bookings pb ON pb.booking_id=b.id
        LEFT JOIN dispatch.packages p ON p.id=pb.package_id WHERE b.id=entity_key;
    WHEN 'dispute_events', 'remedy_events' THEN
      entity := 'dispute'; entity_key := NEW.dispute_id; heading := 'Hồ sơ khiếu nại có cập nhật';
      kind := CASE WHEN TG_TABLE_NAME = 'remedy_events' THEN 'REMEDY_' || NEW.event_type
        WHEN NEW.event_type = 'DISPUTE_OPENED' THEN NEW.event_type ELSE 'DISPUTE_' || NEW.event_type END;
      SELECT ARRAY[d.claimant_id,d.respondent_id,d.mediator_id] INTO recipients
        FROM dispatch.disputes d WHERE d.id=entity_key;
  END CASE;
  IF package_key IS NOT NULL THEN
    SELECT ARRAY[p.coop_id,p.provider_id,p.operator_id] || ARRAY(
      SELECT b.owner_id FROM dispatch.package_bookings pb JOIN dispatch.bookings b ON b.id=pb.booking_id WHERE pb.package_id=p.id
    ) INTO recipients FROM dispatch.packages p WHERE p.id=package_key;
  END IF;
  PERFORM dispatch.publish_user_notification(recipients, kind, entity, entity_key::text, heading, NULL, data);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER booking_event_notification AFTER INSERT ON dispatch.booking_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER package_created_notification AFTER INSERT ON dispatch.packages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER package_changed_notification AFTER UPDATE ON dispatch.packages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (ROW(OLD.status,OLD.window_start_at,OLD.window_end_at) IS DISTINCT FROM ROW(NEW.status,NEW.window_start_at,NEW.window_end_at))
  EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER shift_event_notification AFTER INSERT ON dispatch.shift_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER acceptance_notification AFTER INSERT ON dispatch.acceptances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER acceptance_consent_notification AFTER INSERT ON dispatch.acceptance_consents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER dispute_event_notification AFTER INSERT ON dispatch.dispute_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();
CREATE CONSTRAINT TRIGGER remedy_event_notification AFTER INSERT ON dispatch.remedy_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dispatch.notify_domain_transition();

-- Account service retains no direct access to dispatch storage. Only the role-request trigger crosses schemas.
CREATE FUNCTION account.notify_role_request() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM dispatch.publish_user_notification(ARRAY[NEW.user_id,NEW.decided_by],
    'ROLE_REQUEST_' || NEW.status, 'role_request', NEW.id::text, 'Yêu cầu cấp vai trò có cập nhật', NULL,
    jsonb_build_object('role',NEW.requested_role,'status',NEW.status));
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER role_request_notification AFTER INSERT OR UPDATE ON account.role_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION account.notify_role_request();

REVOKE EXECUTE ON FUNCTION account.notify_role_request() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION dispatch.publish_user_notification(UUID[],TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;

-- Fresh databases create runtime roles later via bootstrap-db; upgraded databases already have them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'booking_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON dispatch.user_notifications TO booking_runtime;
    GRANT USAGE, SELECT ON SEQUENCE dispatch.user_notifications_id_seq TO booking_runtime;
    GRANT EXECUTE ON FUNCTION dispatch.publish_user_notification(UUID[],TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) TO booking_runtime;
  END IF;
END;
$$;
