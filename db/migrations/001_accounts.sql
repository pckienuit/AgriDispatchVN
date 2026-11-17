-- Account service schema: identities, farmer-only role grants, opaque sessions, DB-backed throttle buckets.
CREATE SCHEMA account;

CREATE TABLE account.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CONSTRAINT users_email_key UNIQUE
    CONSTRAINT users_email_normalized CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name text NOT NULL CONSTRAINT users_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  password_hash text NOT NULL CONSTRAINT users_password_format CHECK (
    password_hash ~ '^scrypt:v1:N=16384:r=8:p=1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{86}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account.user_roles (
  user_id uuid NOT NULL REFERENCES account.users (id) ON DELETE CASCADE,
  role text NOT NULL CONSTRAINT user_roles_known_role CHECK (role IN ('farmer', 'provider', 'operator', 'coop', 'admin')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

-- Only the SHA-256 digest of an opaque 256-bit token is stored.
CREATE TABLE account.sessions (
  token_hash text PRIMARY KEY CONSTRAINT sessions_token_digest CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES account.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON account.sessions (user_id);
CREATE INDEX sessions_expires_idx ON account.sessions (expires_at);

-- Shared fixed-window counters. Bucket is a SHA-256 digest of scope and identity, so no email or IP is stored.
CREATE TABLE account.rate_limits (
  bucket text PRIMARY KEY CONSTRAINT rate_limits_bucket_digest CHECK (bucket ~ '^[0-9a-f]{64}$'),
  hits integer NOT NULL CONSTRAINT rate_limits_hits_positive CHECK (hits >= 1),
  window_ends_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_window_idx ON account.rate_limits (window_ends_at);
