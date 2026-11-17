-- G3 booking slice: immutable quote snapshot, append-only request events, scoped idempotency keys.
-- Snapshot columns copy field and service values at request time. Later edits to dispatch.fields or
-- dispatch.services never change stored bookings.
-- ponytail: demo engineering policy, not a legal or market rule. Total = round-half-up(price_per_ha_vnd * area_m2 / 10000) VND.
-- Ceiling: no VAT, fees, deposits or other rounding rules. Upgrade: versioned pricing rule once agreed by the project.

-- Composite key lets a booking prove that its field belongs to its owner.
ALTER TABLE dispatch.fields ADD CONSTRAINT fields_id_owner_key UNIQUE (id, owner_id);

CREATE TABLE dispatch.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  field_id UUID NOT NULL,
  service_id UUID NOT NULL REFERENCES dispatch.services (id),
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED')),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  field_name TEXT NOT NULL CHECK (btrim(field_name) <> '' AND char_length(field_name) <= 120),
  field_area_m2 INTEGER NOT NULL CHECK (field_area_m2 > 0 AND field_area_m2 <= 10000000),
  service_code TEXT NOT NULL CHECK (char_length(service_code) BETWEEN 3 AND 40),
  service_name TEXT NOT NULL CHECK (btrim(service_name) <> '' AND char_length(service_name) <= 160),
  service_data_label TEXT NOT NULL CHECK (service_data_label IN ('synthetic', 'real-labelled')),
  price_per_ha_vnd BIGINT NOT NULL CHECK (price_per_ha_vnd > 0),
  total_vnd BIGINT NOT NULL CHECK (total_vnd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_field_owner_fk FOREIGN KEY (field_id, owner_id) REFERENCES dispatch.fields (id, owner_id),
  CONSTRAINT bookings_schedule_order CHECK (end_at > start_at),
  -- Demo validation bound (30 days), not a business rule.
  CONSTRAINT bookings_span_bound CHECK (end_at - start_at <= interval '30 days'),
  CONSTRAINT bookings_quote_round_half_up CHECK (
    total_vnd = floor((price_per_ha_vnd::numeric * field_area_m2 + 5000) / 10000)::bigint
  )
);

CREATE INDEX bookings_owner_created_idx ON dispatch.bookings (owner_id, created_at DESC, id DESC);

CREATE TABLE dispatch.booking_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES dispatch.bookings (id),
  event_type TEXT NOT NULL CHECK (event_type IN ('BOOKING_REQUESTED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('REQUESTED')),
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX booking_events_booking_idx ON dispatch.booking_events (booking_id, sequence);

-- The application inserts a claim row and completes it (booking_id, response) inside one transaction.
-- Concurrent same-key requests wait on the unique key until that transaction commits or rolls back.
CREATE TABLE dispatch.idempotency_keys (
  actor_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('booking.create')),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._~-]{16,128}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  booking_id UUID REFERENCES dispatch.bookings (id),
  response JSON,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idempotency_key),
  CONSTRAINT idempotency_completed_pair CHECK ((booking_id IS NULL) = (response IS NULL))
);

-- Bookings and request events are append-only in G3. A later state-transition migration replaces this guard.
CREATE FUNCTION dispatch.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'booking history is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER bookings_no_update BEFORE UPDATE ON dispatch.bookings
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_mutation();
CREATE TRIGGER bookings_no_delete BEFORE DELETE ON dispatch.bookings
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_mutation();
CREATE TRIGGER booking_events_no_update BEFORE UPDATE ON dispatch.booking_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_mutation();
CREATE TRIGGER booking_events_no_delete BEFORE DELETE ON dispatch.booking_events
  FOR EACH ROW EXECUTE FUNCTION dispatch.forbid_mutation();
