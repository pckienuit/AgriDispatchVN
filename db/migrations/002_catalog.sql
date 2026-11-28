-- G2 catalog and asset slice. Dispatch schema holds operational tables only.
-- Owner IDs come from the account service via verified auth; no foreign key to an identity table here.
-- All seeded service rows are synthetic demo values, not market prices.

CREATE SCHEMA IF NOT EXISTS dispatch;

CREATE TABLE dispatch.services (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 3 AND 40 AND code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 160),
  price_per_ha_vnd BIGINT NOT NULL CHECK (price_per_ha_vnd > 0),
  data_label TEXT NOT NULL CHECK (data_label IN ('synthetic', 'real-labelled')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX services_active_order_idx ON dispatch.services (code, id) WHERE active;

CREATE TABLE dispatch.fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  locality TEXT NOT NULL CHECK (btrim(locality) <> '' AND char_length(locality) <= 200),
  area_m2 INTEGER NOT NULL CHECK (area_m2 > 0 AND area_m2 <= 10000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fields_owner_created_idx ON dispatch.fields (owner_id, created_at DESC, id DESC);

CREATE TABLE dispatch.machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  machine_type TEXT NOT NULL CHECK (machine_type IN ('harvester', 'tractor', 'drone')),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX machines_owner_created_idx ON dispatch.machines (owner_id, created_at DESC, id DESC);
