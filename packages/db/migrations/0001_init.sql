-- PANTAU MVP-0 schema. Forward-only. {{APP_ROLE}} is the non-owner, non-BYPASSRLS application role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{{APP_ROLE}}') THEN
    RAISE EXCEPTION 'application role {{APP_ROLE}} does not exist; run scripts/setup-local-db.sh first';
  END IF;
END $$;

-- ===== Better Auth tables (not tenant-scoped; managed by Better Auth) =====
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "organization" (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  logo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata text
);
CREATE TABLE "session" (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  active_organization_id text
);
CREATE INDEX session_user_idx ON "session"(user_id);
CREATE TABLE "account" (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_idx ON "account"(user_id);
CREATE TABLE "verification" (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "member" (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE TABLE "invitation" (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

-- ===== Tenant tables (organization_id + RLS) =====
CREATE TABLE site (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  timezone text NOT NULL DEFAULT 'Asia/Makassar',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);
CREATE TABLE device (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('nvr','ipc')),
  brand text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  firmware text NOT NULL DEFAULT '',
  adapter_id text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'online',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (site_id, organization_id) REFERENCES site(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX device_site_idx ON device(organization_id, site_id);
-- Interim vault (PRD A2 says credentials live only in the on-site agent; the agent is out of MVP-0 scope).
CREATE TABLE device_secret (
  device_id text PRIMARY KEY,
  organization_id text NOT NULL,
  credentials_enc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, organization_id) REFERENCES device(id, organization_id) ON DELETE CASCADE
);
CREATE TABLE camera (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  channel text NOT NULL,
  name text NOT NULL,
  has_ptz boolean NOT NULL DEFAULT false,
  main_codec text,
  sub_codec text,
  status text NOT NULL DEFAULT 'online',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, channel),
  FOREIGN KEY (device_id, organization_id) REFERENCES device(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX camera_org_idx ON camera(organization_id, device_id);
CREATE TABLE audit_log (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  actor_id text,
  action text NOT NULL,
  target text,
  ip text,
  at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_org_at_idx ON audit_log(organization_id, at DESC);

-- Append-only for everyone, including the table owner (statement-level so it fires even when RLS hides all rows).
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $f$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- ===== Row-level security =====
ALTER TABLE site ENABLE ROW LEVEL SECURITY;           ALTER TABLE site FORCE ROW LEVEL SECURITY;
ALTER TABLE device ENABLE ROW LEVEL SECURITY;         ALTER TABLE device FORCE ROW LEVEL SECURITY;
ALTER TABLE device_secret ENABLE ROW LEVEL SECURITY;  ALTER TABLE device_secret FORCE ROW LEVEL SECURITY;
ALTER TABLE camera ENABLE ROW LEVEL SECURITY;         ALTER TABLE camera FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;      ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON site FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_isolation ON device FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_isolation ON device_secret FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_isolation ON camera FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_read ON audit_log FOR SELECT TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_insert ON audit_log FOR INSERT TO {{APP_ROLE}}
  WITH CHECK (organization_id = current_setting('app.org_id', true));

-- ===== Grants =====
GRANT USAGE ON SCHEMA public TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "organization", "session", "account", "verification", "member", "invitation" TO {{APP_ROLE}};
GRANT SELECT, INSERT, UPDATE, DELETE ON site, device, device_secret, camera TO {{APP_ROLE}};
GRANT SELECT, INSERT ON audit_log TO {{APP_ROLE}};
