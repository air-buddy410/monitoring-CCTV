-- PANTAU M2 (first slice): agent enrollment and agent registry. Forward-only.
-- PRD section 8: `agent` and `agent_enrollment`. Credentials never live here; only a token HASH.

CREATE TABLE agent_enrollment (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (site_id, organization_id) REFERENCES site(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX agent_enrollment_site_idx ON agent_enrollment(organization_id, site_id);

CREATE TABLE agent (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL DEFAULT '',
  public_key text,
  token_hash text NOT NULL,
  last_seen_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','online','offline','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (site_id, organization_id) REFERENCES site(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX agent_site_idx ON agent(organization_id, site_id);
CREATE INDEX agent_token_idx ON agent(token_hash);

ALTER TABLE agent ENABLE ROW LEVEL SECURITY;            ALTER TABLE agent FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_enrollment ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_enrollment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agent FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_isolation ON agent_enrollment FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON agent, agent_enrollment TO {{APP_ROLE}};
