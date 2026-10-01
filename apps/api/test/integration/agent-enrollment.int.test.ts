import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  newAgentPublicKey,
  sha256Hex,
  type Tenant,
  type TestEnv,
} from "../helpers";

interface Enrollment {
  id: string;
  siteId: string;
  token: string;
  expiresAt: string;
}
interface Enrolled {
  agentId: string;
  siteId: string;
  agentToken: string;
  websocketPath: string;
}

describe("agent enrollment, agents list and revocation (PRD 4.5, 9.1)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let noc: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let other: Tenant;
  let siteId: string;
  let otherSiteId: string;

  const call = (who: Tenant | null, method: "GET" | "POST", url: string, payload?: unknown) =>
    env.built.app.inject({
      method,
      url,
      headers: who ? { cookie: who.cookie } : {},
      payload: payload as never,
    });
  const mint = async (who: Tenant = owner, site = siteId) => {
    const res = await call(who, "POST", `/v1/sites/${site}/enrollments`, {});
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as Enrollment;
  };
  const enroll = (token: string | null, body: Record<string, unknown> = {}, scheme = "Enroll") =>
    env.built.app.inject({
      method: "POST",
      url: "/v1/agent/enroll",
      headers: token === null ? {} : { authorization: `${scheme} ${token}` },
      payload: {
        name: "Mini PC Lab",
        publicKey: newAgentPublicKey(),
        hostname: "mini-pc",
        agentVersion: "0.1.0",
        ...body,
      },
    });

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "en-owner");
    noc = await addMemberWithRole(env, owner, "en-noc", "noc");
    operator = await addMemberWithRole(env, owner, "en-op", "admin");
    viewer = await addMemberWithRole(env, owner, "en-vw", "member");
    other = await createTenant(env, "en-other");
    siteId = (await createSite(env, owner)).id;
    otherSiteId = (await createSite(env, other)).id;
  });
  afterAll(async () => env.close());

  describe("POST /v1/sites/:id/enrollments", () => {
    it("owner and noc mint a token that lasts 24 hours; operator and viewer cannot", async () => {
      expect((await call(null, "POST", `/v1/sites/${siteId}/enrollments`, {})).statusCode).toBe(401);
      expect((await call(viewer, "POST", `/v1/sites/${siteId}/enrollments`, {})).statusCode).toBe(403);
      expect((await call(operator, "POST", `/v1/sites/${siteId}/enrollments`, {})).statusCode).toBe(403);
      const a = await mint(owner);
      const b = await mint(noc);
      for (const e of [a, b]) {
        expect(e.siteId).toBe(siteId);
        expect(e.token).toMatch(/^pae_[A-Za-z0-9_-]{43}$/);
        const hours = (new Date(e.expiresAt).getTime() - Date.now()) / 3_600_000;
        expect(hours).toBeGreaterThan(23.9);
        expect(hours).toBeLessThanOrEqual(24.001);
      }
      expect(a.token).not.toBe(b.token);
    });

    it("stores only the SHA-256 of the token, never the token", async () => {
      const e = await mint();
      const row = await env.admin.query(`select token_hash from agent_enrollment where id = $1`, [e.id]);
      expect(row.rows[0].token_hash).toBe(sha256Hex(e.token));
      // scan every column of every public table for the plaintext
      const tables = (
        await env.admin.query(`select tablename from pg_tables where schemaname = 'public'`)
      ).rows.map((r) => r.tablename as string);
      for (const t of tables) {
        const hit = await env.admin.query(`select count(*)::int as n from "${t}" x where x::text like $1`, [
          `%${e.token}%`,
        ]);
        expect(hit.rows[0].n, `plaintext enrollment token found in ${t}`).toBe(0);
      }
    });

    it("never logs the token, and the audit entry names the enrollment but not the token", async () => {
      const e = await mint();
      expect(env.logs.join("\n")).not.toContain(e.token);
      const audit = await env.admin.query(
        `select actor_id, meta from audit_log where organization_id = $1 and action = 'agent.enrollment.create' and target = $2`,
        [owner.orgId, e.id],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].actor_id).toBe(owner.userId);
      expect(JSON.stringify(audit.rows[0].meta)).not.toContain(e.token);
    });

    it("another tenant's site is 404, an unknown site is 404, and a body with fields is refused", async () => {
      expect((await call(owner, "POST", `/v1/sites/${otherSiteId}/enrollments`, {})).statusCode).toBe(404);
      expect((await call(owner, "POST", "/v1/sites/site_nope/enrollments", {})).statusCode).toBe(404);
      expect(
        (await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, { organizationId: other.orgId }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("POST /v1/agent/enroll (public, token is the credential)", () => {
    it("registers an agent, returns the long-lived token once, and stores only its hash and the public key", async () => {
      const e = await mint();
      const publicKey = newAgentPublicKey();
      const res = await enroll(e.token, { name: "Agen A", publicKey });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as Enrolled;
      expect(body).toMatchObject({ siteId, websocketPath: "/agent" });
      expect(body.agentId).toMatch(/^agt_/);
      expect(body.agentToken).toMatch(/^pat_[A-Za-z0-9_-]{43}$/);
      const row = await env.admin.query(
        `select name, token_hash, public_key, status, site_id, organization_id from agent where id = $1`,
        [body.agentId],
      );
      expect(row.rows[0]).toMatchObject({
        name: "Agen A",
        token_hash: sha256Hex(body.agentToken),
        public_key: publicKey,
        status: "offline",
        site_id: siteId,
        organization_id: owner.orgId,
      });
      const tables = (
        await env.admin.query(`select tablename from pg_tables where schemaname = 'public'`)
      ).rows.map((r) => r.tablename as string);
      for (const t of tables) {
        const hit = await env.admin.query(`select count(*)::int as n from "${t}" x where x::text like $1`, [
          `%${body.agentToken}%`,
        ]);
        expect(hit.rows[0].n, `agent token in ${t}`).toBe(0);
      }
      expect(env.logs.join("\n")).not.toContain(body.agentToken);
      expect(env.logs.join("\n")).not.toContain(e.token);
    });

    it("a token works once: the second use is refused and creates no agent", async () => {
      const e = await mint();
      expect((await enroll(e.token)).statusCode).toBe(201);
      const before = Number(
        (await env.admin.query(`select count(*) from agent where organization_id = $1`, [owner.orgId]))
          .rows[0].count,
      );
      const again = await enroll(e.token);
      expect(again.statusCode).toBe(401);
      expect((again.json() as { code: string }).code).toBe("enrollment_invalid");
      expect(
        Number(
          (await env.admin.query(`select count(*) from agent where organization_id = $1`, [owner.orgId]))
            .rows[0].count,
        ),
      ).toBe(before);
      const used = await env.admin.query(
        `select used_at, used_by_agent_id from agent_enrollment where id = $1`,
        [e.id],
      );
      expect(used.rows[0].used_at).not.toBeNull();
      expect(used.rows[0].used_by_agent_id).toMatch(/^agt_/);
    });

    it("two simultaneous redemptions of one token produce exactly one agent", async () => {
      const e = await mint();
      const results = await Promise.all(Array.from({ length: 6 }, () => enroll(e.token)));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 401)).toHaveLength(5);
      const n = await env.admin.query(
        `select count(*)::int as n from agent where site_id = $1 and token_hash <> ''`,
        [siteId],
      );
      expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
      const used = await env.admin.query(
        `select count(*)::int as n from agent_enrollment where id = $1 and used_by_agent_id is not null`,
        [e.id],
      );
      expect(used.rows[0].n).toBe(1);
    });

    it("an expired token is refused", async () => {
      const e = await mint();
      await env.admin.query(
        `update agent_enrollment set expires_at = now() - interval '1 second' where id = $1`,
        [e.id],
      );
      const res = await enroll(e.token);
      expect(res.statusCode).toBe(401);
      expect((res.json() as { code: string }).code).toBe("enrollment_invalid");
    });

    it("unknown, malformed, missing and wrong-scheme credentials are all the same 401", async () => {
      const e = await mint();
      const codes = new Set<string>();
      for (const res of [
        await enroll("pae_" + "A".repeat(43)),
        await enroll("garbage"),
        await enroll(null),
        await enroll(e.token, {}, "Bearer"),
        await enroll(e.token, {}, "Agent"),
      ]) {
        expect(res.statusCode).toBe(401);
        codes.add((res.json() as { code: string }).code);
      }
      expect([...codes]).toEqual(["enrollment_invalid"]);
      // none of those burned the real token
      expect((await enroll(e.token)).statusCode).toBe(201);
    });

    it("an agent token cannot be used as an enrollment token and vice versa", async () => {
      const e = await mint();
      const agent = (await enroll(e.token)).json() as Enrolled;
      expect((await enroll(agent.agentToken)).statusCode).toBe(401);
      const e2 = await mint();
      const wsStyle = await env.built.app.inject({
        method: "GET",
        url: "/v1/agents",
        headers: { authorization: `Agent ${e2.token}` },
      });
      expect(wsStyle.statusCode).toBe(401);
    });

    it("validates the body: public key must be an Ed25519 SPKI key, extra fields refused", async () => {
      const e = await mint();
      for (const bad of [
        { publicKey: "AAAA" },
        { publicKey: Buffer.alloc(44, 1).toString("base64") },
        { name: "" },
        { extra: "x" },
        { organizationId: other.orgId },
      ]) {
        const res = await enroll(e.token, bad);
        expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      }
      // the token survives bad bodies
      expect((await enroll(e.token)).statusCode).toBe(201);
    });

    it("is audited as agent.enroll with no actor and without any token", async () => {
      const e = await mint();
      const res = (await enroll(e.token)).json() as Enrolled;
      const audit = await env.admin.query(
        `select actor_id, meta from audit_log where organization_id = $1 and action = 'agent.enroll' and target = $2`,
        [owner.orgId, res.agentId],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].actor_id).toBeNull();
      expect(JSON.stringify(audit.rows[0].meta)).not.toMatch(/pat_|pae_/);
    });

    it("is rate limited per client address", async () => {
      const limited = await createTestEnv({ RATE_LIMIT_AUTH_PER_MIN: "5" });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 8; i++) {
          const r = await limited.built.app.inject({
            method: "POST",
            url: "/v1/agent/enroll",
            headers: { authorization: "Enroll pae_" + "B".repeat(43) },
            payload: { name: "x", publicKey: newAgentPublicKey() },
            remoteAddress: "10.8.8.8",
          });
          codes.push(r.statusCode);
        }
        expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
        expect(codes.slice(5).every((c) => c === 429)).toBe(true);
      } finally {
        await limited.close();
      }
    });
  });

  describe("GET /v1/agents, GET /v1/agents/:id, POST /v1/agents/:id/revoke", () => {
    let agentId: string;
    beforeAll(async () => {
      agentId = ((await enroll((await mint()).token, { name: "Agen Daftar" })).json() as Enrolled).agentId;
    });

    it("lists and reads agents without ever exposing the token, its hash or the public key", async () => {
      const list = await call(owner, "GET", "/v1/agents");
      expect(list.statusCode).toBe(200);
      const items = (list.json() as { items: Record<string, unknown>[] }).items;
      const mine = items.find((a) => a.id === agentId);
      expect(mine).toMatchObject({
        id: agentId,
        siteId,
        name: "Agen Daftar",
        status: "offline",
        revokedAt: null,
      });
      expect(typeof mine?.publicKeyFingerprint).toBe("string");
      expect((mine?.publicKeyFingerprint as string).length).toBe(16);
      const text = list.body;
      expect(text).not.toMatch(/token/i);
      expect(text).not.toMatch(/public_?key"/i);
      const one = await call(owner, "GET", `/v1/agents/${agentId}`);
      expect(one.statusCode).toBe(200);
      expect(one.body).not.toMatch(/token/i);
    });

    it("roles: owner, noc and operator read; viewer and anonymous cannot", async () => {
      expect((await call(null, "GET", "/v1/agents")).statusCode).toBe(401);
      expect((await call(viewer, "GET", "/v1/agents")).statusCode).toBe(403);
      for (const who of [owner, noc, operator]) {
        expect((await call(who, "GET", "/v1/agents")).statusCode).toBe(200);
        expect((await call(who, "GET", `/v1/agents/${agentId}`)).statusCode).toBe(200);
      }
    });

    it("tenant isolation: tenant B sees none of A's agents and cannot read or revoke them", async () => {
      const bList = (await call(other, "GET", "/v1/agents")).json() as { items: { id: string }[] };
      expect(bList.items.find((a) => a.id === agentId)).toBeUndefined();
      expect((await call(other, "GET", `/v1/agents/${agentId}`)).statusCode).toBe(404);
      expect((await call(other, "POST", `/v1/agents/${agentId}/revoke`, {})).statusCode).toBe(404);
      const row = await env.admin.query(`select status from agent where id = $1`, [agentId]);
      expect(row.rows[0].status).not.toBe("revoked");
    });

    it("revoke: owner and noc only; sets revoked, is idempotent and audited", async () => {
      const id = ((await enroll((await mint()).token, { name: "Agen Cabut" })).json() as Enrolled).agentId;
      expect((await call(null, "POST", `/v1/agents/${id}/revoke`, {})).statusCode).toBe(401);
      expect((await call(viewer, "POST", `/v1/agents/${id}/revoke`, {})).statusCode).toBe(403);
      expect((await call(operator, "POST", `/v1/agents/${id}/revoke`, {})).statusCode).toBe(403);
      const res = await call(noc, "POST", `/v1/agents/${id}/revoke`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id, status: "revoked" });
      expect((res.json() as { revokedAt: string }).revokedAt).toBeTruthy();
      const again = await call(owner, "POST", `/v1/agents/${id}/revoke`, {});
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: "revoked" });
      const audit = await env.admin.query(
        `select count(*)::int as n from audit_log where organization_id = $1 and action = 'agent.revoke' and target = $2`,
        [owner.orgId, id],
      );
      expect(audit.rows[0].n).toBe(1);
    });

    it("an unknown agent is 404", async () => {
      expect((await call(owner, "GET", "/v1/agents/agt_nope")).statusCode).toBe(404);
      expect((await call(owner, "POST", "/v1/agents/agt_nope/revoke", {})).statusCode).toBe(404);
    });
  });

  describe("row level security for tokens", () => {
    it("without a token hash the application role sees no agent and no enrollment", async () => {
      const urls = inject("dbUrls");
      const app = new pg.Pool({ connectionString: urls.app, max: 1 });
      try {
        expect((await app.query("select 1 from agent")).rowCount).toBe(0);
        expect((await app.query("select 1 from agent_enrollment")).rowCount).toBe(0);
      } finally {
        await app.end();
      }
    });

    it("a token hash exposes exactly one row, read-only", async () => {
      const e = await mint();
      const urls = inject("dbUrls");
      const app = new pg.Pool({ connectionString: urls.app, max: 1 });
      try {
        const c = await app.connect();
        try {
          await c.query("begin");
          await c.query("select set_config('app.token_hash', $1, true)", [sha256Hex(e.token)]);
          const rows = await c.query("select id from agent_enrollment");
          expect(rows.rows.map((r) => r.id)).toEqual([e.id]);
          const upd = await c.query("update agent_enrollment set used_at = now() where id = $1", [e.id]);
          expect(upd.rowCount).toBe(0);
          const del = await c.query("delete from agent_enrollment where id = $1", [e.id]);
          expect(del.rowCount).toBe(0);
        } finally {
          await c.query("rollback").catch(() => undefined);
          c.release();
        }
      } finally {
        await app.end();
      }
    });

    it("agent and agent_enrollment have RLS enabled and forced", async () => {
      const r = await env.admin.query(
        `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
        [["agent", "agent_enrollment"]],
      );
      expect(r.rows).toHaveLength(2);
      for (const row of r.rows)
        expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  it("deleting the site removes its agents and enrollments", async () => {
    const s = await createSite(env, owner, "Hapus Agen");
    const e = await mint(owner, s.id);
    const agent = (await enroll(e.token)).json() as Enrolled;
    expect((await call(owner, "GET", `/v1/agents/${agent.agentId}`)).statusCode).toBe(200);
    const del = await env.built.app.inject({
      method: "DELETE",
      url: `/v1/sites/${s.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(del.statusCode).toBe(204);
    expect((await call(owner, "GET", `/v1/agents/${agent.agentId}`)).statusCode).toBe(404);
    expect((await env.admin.query(`select 1 from agent_enrollment where id = $1`, [e.id])).rowCount).toBe(0);
  });
});
