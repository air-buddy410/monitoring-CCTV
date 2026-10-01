-- PANTAU M2 (second slice): agent channel support. Forward-only.
-- PRD section 8: `device.agent_id` links a device to the agent that discovered it.
-- No privileged lookup is added here: an agent token embeds its org and agent id (like the enrollment
-- token does), so the channel authenticates inside the normal tenant transaction and RLS still applies.

ALTER TABLE device ADD COLUMN agent_id text;
CREATE INDEX device_agent_idx ON device(organization_id, agent_id);
