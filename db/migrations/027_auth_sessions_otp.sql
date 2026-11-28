-- Keep the existing account schema and Bearer sessions; do not rename live relations.
-- The volatile default also assigns distinct IDs to sessions issued before 027.
ALTER TABLE account.sessions
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT sessions_id_key UNIQUE (id),
  ADD COLUMN user_agent varchar(160),
  ADD COLUMN ip_summary cidr;

CREATE TABLE account.password_reset_tokens (
  user_id uuid PRIMARY KEY REFERENCES account.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  used_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);
CREATE INDEX password_reset_tokens_expiry_idx ON account.password_reset_tokens (expires_at);

-- On upgrades where runtime roles already exist. New installs bootstrap after migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'account_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON account.sessions, account.password_reset_tokens TO account_runtime;
  END IF;
END $$;
