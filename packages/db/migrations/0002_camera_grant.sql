-- M1: per-camera / per-site grants that narrow a tenant role (PRD F7, model section 8).
CREATE TABLE camera_grant (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('site','camera')),
  scope_id text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('view','operate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, scope, scope_id)
);
CREATE INDEX camera_grant_org_user_idx ON camera_grant(organization_id, user_id);

ALTER TABLE camera_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE camera_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON camera_grant FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON camera_grant TO {{APP_ROLE}};
