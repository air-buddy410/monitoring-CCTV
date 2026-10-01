-- PANTAU M1: two-factor (Better Auth plugin tables) and per-camera grants. Forward-only.

-- ===== Better Auth two-factor plugin (not tenant-scoped; managed by Better Auth) =====
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

-- ===== camera_grant (PRD section 8): narrows a member's tenant role to a site or one camera =====
CREATE TABLE camera_grant (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('site','camera')),
  scope_id text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('view','operate')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, scope, scope_id),
  -- a grant disappears with its member
  FOREIGN KEY (organization_id, user_id) REFERENCES "member"(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX camera_grant_scope_idx ON camera_grant(organization_id, scope, scope_id);

-- scope_id is polymorphic, so a foreign key cannot cascade it; these triggers remove dangling grants.
-- BEFORE DELETE so that, for a site, the cameras still exist when their grants are collected.
CREATE FUNCTION camera_grant_cleanup_site() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM camera_grant WHERE organization_id = OLD.organization_id AND scope = 'site' AND scope_id = OLD.id;
  RETURN OLD;
END $f$;
CREATE FUNCTION camera_grant_cleanup_camera() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM camera_grant WHERE organization_id = OLD.organization_id AND scope = 'camera' AND scope_id = OLD.id;
  RETURN OLD;
END $f$;
CREATE TRIGGER site_grant_cleanup BEFORE DELETE ON site
  FOR EACH ROW EXECUTE FUNCTION camera_grant_cleanup_site();
CREATE TRIGGER camera_grant_cleanup BEFORE DELETE ON camera
  FOR EACH ROW EXECUTE FUNCTION camera_grant_cleanup_camera();

ALTER TABLE camera_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON camera_grant FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON two_factor, camera_grant TO {{APP_ROLE}};
