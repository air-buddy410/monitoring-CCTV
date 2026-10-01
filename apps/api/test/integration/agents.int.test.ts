import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  type Tenant,
  type TestEnv,
} from "../helpers";

interface AgentRow {
  id: string;
  siteId: string;
  name: string;
  version: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
}

describe("/v1 agents (M2 first slice: enrollment + registry)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let operator: Tenant;
  let noc: Tenant;
  let other: Tenant;
  let siteId: string;

  const call = (who: Tenant | null, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    env.built.app.inject({
      method,
      url,
      headers: who ? { cookie: who.cookie } : {},
      payload: payload as never,
    });

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "ag-owner");
    operator = await addMemberWithRole(env, owner, "ag-operator", "admin");
    noc = await addMemberWithRole(env, owner, "ag-noc", "noc");
    other = await createTenant(env, "ag-other");
    siteId = (await createSite(env, owner)).id;
  });
  afterAll(async () => env.close());

  describe("enrollment", () => {
    it("owner creates a single-use enrollment token for a site", async () => {
      const res = await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, {
        siteId,
        name: "Mini PC Jakarta",
        ttlMinutes: 30,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; siteId: string; token: string; expiresAt: string };
      expect(body.siteId).toBe(siteId);
      expect(body.token).toMatch(/^enr\./);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      // the raw token must never be stored; only its hash
      const rows = await env.admin.query("select token_hash from agent_enrollment where id = $1", [body.id]);
      expect(rows.rows[0].token_hash).not.toContain(body.token);
      expect(rows.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("noc may create enrollments; operator and viewer may not", async () => {
      expect(
        (await call(noc, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "n" })).statusCode,
      ).toBe(201);
      expect(
        (await call(operator, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "o" })).statusCode,
      ).toBe(403);
    });

    it("an unknown site is a 404 and another tenant's site is invisible", async () => {
      expect(
        (
          await call(owner, "POST", "/v1/sites/site_missing/enrollments", {
            siteId: "site_missing",
            name: "x",
          })
        ).statusCode,
      ).toBe(404);
      const otherSite = (await createSite(env, other)).id;
      expect(
        (await call(owner, "POST", `/v1/sites/${otherSite}/enrollments`, { siteId: otherSite, name: "x" }))
          .statusCode,
      ).toBe(404);
    });

    it("rejects an oversized TTL instead of silently trusting it", async () => {
      const res = await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, {
        siteId,
        name: "x",
        ttlMinutes: 100000,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("enroll", () => {
    const enrollToken = async (who: Tenant): Promise<string> => {
      const res = await call(who, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "mini" });
      return (res.json() as { token: string }).token;
    };

    it("exchanges a single-use token for a long-lived agent token and registers the agent", async () => {
      const token = await enrollToken(owner);
      const res = await call(null, "POST", "/v1/agents/enroll", {
        token,
        name: "Agen Bandung",
        version: "0.1.0",
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { agentId: string; agentToken: string };
      expect(body.agentToken).toMatch(/^agt\./);
      const list = (await call(owner, "GET", "/v1/agents")).json() as { items: AgentRow[] };
      const found = list.items.find((a) => a.id === body.agentId);
      expect(found).toMatchObject({ name: "Agen Bandung", version: "0.1.0", status: "online", siteId });
      // the agent token hash is stored, never the token
      const rows = await env.admin.query("select token_hash from agent where id = $1", [body.agentId]);
      expect(rows.rows[0].token_hash).not.toContain(body.agentToken);
    });

    it("the same enrollment token cannot be used twice", async () => {
      const token = await enrollToken(owner);
      expect((await call(null, "POST", "/v1/agents/enroll", { token, name: "a" })).statusCode).toBe(201);
      expect((await call(null, "POST", "/v1/agents/enroll", { token, name: "b" })).statusCode).toBe(401);
    });

    it("a forged or malformed token is refused", async () => {
      // structurally invalid tokens that still pass the schema are an auth failure
      for (const bad of ["nope", "enr.org_x.enr_y.short", "enr.org_x.enr_y.!!!!!!!!!!!!!!!!!!!!"]) {
        expect(
          (await call(null, "POST", "/v1/agents/enroll", { token: bad, name: "x" })).statusCode,
          bad,
        ).toBe(401);
      }
      // an empty token fails input validation before auth
      expect((await call(null, "POST", "/v1/agents/enroll", { token: "", name: "x" })).statusCode).toBe(400);
    });

    it("an expired enrollment token is refused", async () => {
      const res = await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "exp" });
      const { id, token } = res.json() as { id: string; token: string };
      await env.admin.query(
        "update agent_enrollment set expires_at = now() - interval '1 minute' where id = $1",
        [id],
      );
      expect((await call(null, "POST", "/v1/agents/enroll", { token, name: "x" })).statusCode).toBe(401);
    });

    it("a failed enrollment is audited without leaking the token", async () => {
      await call(null, "POST", "/v1/agents/enroll", {
        token: "enr.org_x.enr_y.!!!!!!!!!!!!!!!!!!!!",
        name: "x",
      });
      const res = await call(owner, "GET", "/v1/audit?limit=200");
      const items = (res.json() as { items: { action: string; meta: Record<string, unknown> }[] }).items;
      const failed = items.find((i) => i.action === "agent.enroll.failed");
      expect(failed).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain("!!!!!!!!");
    });
  });

  describe("registry access control", () => {
    it("operator may not list agents; owner and noc may", async () => {
      expect((await call(operator, "GET", "/v1/agents")).statusCode).toBe(403);
      expect((await call(owner, "GET", "/v1/agents")).statusCode).toBe(200);
      expect((await call(noc, "GET", "/v1/agents")).statusCode).toBe(200);
    });

    it("an agent is invisible to another tenant", async () => {
      const token = (
        await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "iso" })
      ).json() as {
        token: string;
      };
      const enrolled = (
        await call(null, "POST", "/v1/agents/enroll", { token: token.token, name: "iso" })
      ).json() as {
        agentId: string;
      };
      expect((await call(other, "GET", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(404);
      expect((await call(owner, "GET", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(200);
    });
  });

  describe("revoke and delete", () => {
    it("revoke marks the agent revoked and rotates its token hash", async () => {
      const token = (
        await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "rv" })
      ).json() as {
        token: string;
      };
      const enrolled = (
        await call(null, "POST", "/v1/agents/enroll", { token: token.token, name: "rv" })
      ).json() as {
        agentId: string;
      };
      const before = await env.admin.query("select token_hash from agent where id = $1", [enrolled.agentId]);
      const rev = await call(owner, "POST", `/v1/agents/${enrolled.agentId}/revoke`);
      expect(rev.statusCode).toBe(200);
      expect((rev.json() as AgentRow).status).toBe("revoked");
      const after = await env.admin.query("select token_hash from agent where id = $1", [enrolled.agentId]);
      expect(after.rows[0].token_hash).not.toBe(before.rows[0].token_hash);
    });

    it("delete requires a revoked agent and owner role", async () => {
      const token = (
        await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, { siteId, name: "dl" })
      ).json() as {
        token: string;
      };
      const enrolled = (
        await call(null, "POST", "/v1/agents/enroll", { token: token.token, name: "dl" })
      ).json() as {
        agentId: string;
      };
      expect((await call(owner, "DELETE", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(409);
      expect((await call(noc, "POST", `/v1/agents/${enrolled.agentId}/revoke`)).statusCode).toBe(200);
      expect((await call(noc, "DELETE", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(403);
      expect((await call(owner, "DELETE", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(204);
      expect((await call(owner, "GET", `/v1/agents/${enrolled.agentId}`)).statusCode).toBe(404);
    });
  });
});
