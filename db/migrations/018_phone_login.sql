-- Phone-number sign-in (UI decision D4, 19 November 2026). Existing email accounts keep working.
-- Every account needs at least one identifier. Phone uses the Vietnamese mobile national format 0XXXXXXXXX;
-- the service normalizes +84 and separators before writing. No OTP: password stays the credential.
ALTER TABLE account.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE account.users ADD COLUMN phone text
  CONSTRAINT users_phone_key UNIQUE
  CONSTRAINT users_phone_format CHECK (phone ~ '^0[35789][0-9]{8}$');
ALTER TABLE account.users ADD CONSTRAINT users_identifier_present CHECK (email IS NOT NULL OR phone IS NOT NULL);
