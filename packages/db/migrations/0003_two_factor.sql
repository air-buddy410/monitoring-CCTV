-- M1: Better Auth two-factor (TOTP + backup codes), PRD F7 / section 11.
-- The plugin requires the extra user column and the two_factor table.
ALTER TABLE "user" ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX two_factor_user_idx ON two_factor(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON two_factor TO {{APP_ROLE}};
