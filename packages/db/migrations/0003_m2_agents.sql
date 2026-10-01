-- PANTAU M2: on-site agents, enrollment tokens, and device ownership by agent. Forward-only.

CREATE TABLE agent (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  name text NOT NULL,
  version text NOT NULL DEFAULT '',
  go2rtc_version text,
  hostname text NOT NULL DEFAULT '',
  public_key text NOT NULL,
  -- SHA-256 of the long-lived agent token; the token itself is never stored (PRD section 8)
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','revoked')),
  last_seen_at timestamptz,
  last_status jsonb,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (site_id, organization_id) REFERENCES site(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX agent_site_idx ON agent(organization_id, site_id);

CREATE TABLE agent_enrollment (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  site_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (site_id, organization_id) REFERENCES site(id, organization_id) ON DELETE CASCADE
);

-- Devices reported by an agent. agent_device_key is the agent's own stable id for the device.
ALTER TABLE device ADD COLUMN agent_id text;
ALTER TABLE device ADD COLUMN agent_device_key text;
ALTER TABLE device ADD FOREIGN KEY (agent_id, organization_id) REFERENCES agent(id, organization_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX device_agent_key_idx ON device(agent_id, agent_device_key) WHERE agent_id IS NOT NULL;
ALTER TABLE device ADD CONSTRAINT device_agent_key_pair CHECK ((agent_id IS NULL) = (agent_device_key IS NULL));

ALTER TABLE agent ENABLE ROW LEVEL SECURITY;            ALTER TABLE agent FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_enrollment ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_enrollment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agent FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
CREATE POLICY tenant_isolation ON agent_enrollment FOR ALL TO {{APP_ROLE}}
  USING (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));

-- An agent presents only a token, so the tenant is not known yet. These policies let the application find exactly the
-- row whose hash it was handed (set per transaction as app.token_hash) and nothing else. A missing setting matches no row.
CREATE POLICY token_lookup ON agent FOR SELECT TO {{APP_ROLE}}
  USING (token_hash = current_setting('app.token_hash', true));
CREATE POLICY token_lookup ON agent_enrollment FOR SELECT TO {{APP_ROLE}}
  USING (token_hash = current_setting('app.token_hash', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON agent, agent_enrollment TO {{APP_ROLE}};
