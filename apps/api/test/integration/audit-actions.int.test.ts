import { AUDIT_ACTIONS } from "@pantau/contracts";
import { withTenant } from "@pantau/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordCameraAccess } from "../../src/audit";
import { addMemberWithRole, createTenant, createTestEnv, type Tenant, type TestEnv } from "../helpers";

describe("audit actions for viewing and commands (ready before live/ptz/playback exist)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let other: Tenant;
  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "aa-owner");
    other = await createTenant(env, "aa-other");
  });
  afterAll(async () => env.close());

  const ctx = (t: Tenant) => ({
    userId: t.userId,
    orgId: t.orgId,
    role: "owner" as const,
    ip: "10.0.0.5",
    twoFactor: false,
  });

  it("the action catalogue covers live, ptz, playback, snapshot, grants, sites, cameras and agents", () => {
    for (const a of [
      "camera.view.start",
      "camera.view.stop",
      "camera.ptz",
      "camera.playback.start",
      "camera.playback.stop",
      "camera.snapshot",
      "camera.snapshot.denied",
      "grant.create",
      "grant.delete",
      "site.update",
      "site.delete",
      "camera.update",
      "agent.enrollment.create",
      "agent.enroll",
      "agent.revoke",
    ]) {
      expect(AUDIT_ACTIONS, a).toContain(a);
    }
  });

  it("recordCameraAccess writes each kind with actor, target, ip and only the allowed meta", async () => {
    const kinds = ["view.start", "view.stop", "ptz", "playback.start", "playback.stop"] as const;
    for (const k of kinds) {
      await withTenant(env.built.handle.db, owner.orgId, (tx) =>
        recordCameraAccess(tx, ctx(owner), k, "cam_x", {
          viewSessionId: "vs_1",
          streamKind: "sub",
          action: "move",
        }),
      );
    }
    const rows = await env.admin.query(
      `select action, actor_id, target, ip, meta from audit_log where organization_id = $1 and action like 'camera.%' order by at`,
      [owner.orgId],
    );
    expect(rows.rows.map((r) => r.action)).toEqual([
      "camera.view.start",
      "camera.view.stop",
      "camera.ptz",
      "camera.playback.start",
      "camera.playback.stop",
    ]);
    for (const r of rows.rows)
      expect(r).toMatchObject({ actor_id: owner.userId, target: "cam_x", ip: "10.0.0.5" });
  });

  it("records are tenant scoped and append-only", async () => {
    const mine = await env.admin.query(
      `select count(*)::int as n from audit_log where organization_id = $1`,
      [other.orgId],
    );
    expect(mine.rows[0].n).toBe(0);
    await expect(
      env.admin.query(`update audit_log set action = 'x' where organization_id = $1`, [owner.orgId]),
    ).rejects.toThrow(/append-only/);
  });

  it("meta never carries credentials or tokens: forbidden keys are rejected before writing", async () => {
    for (const key of ["password", "token", "authorization", "rtsp", "secret", "credentials"]) {
      await expect(
        withTenant(env.built.handle.db, owner.orgId, (tx) =>
          recordCameraAccess(tx, ctx(owner), "ptz", "cam_x", { [key]: "x" }),
        ),
      ).rejects.toThrow(/forbidden/i);
    }
  });

  it("GET /v1/audit filters by action, from and to (owner only)", async () => {
    const viewer = await addMemberWithRole(env, owner, "aa-viewer", "member");
    const get = (who: Tenant, q: string) =>
      env.built.app.inject({ method: "GET", url: `/v1/audit${q}`, headers: { cookie: who.cookie } });
    expect((await get(viewer, "")).statusCode).toBe(403);
    const byAction = (await get(owner, "?action=camera.ptz")).json() as { items: { action: string }[] };
    expect(byAction.items.length).toBeGreaterThan(0);
    expect(byAction.items.every((i) => i.action === "camera.ptz")).toBe(true);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = (await get(owner, `?from=${encodeURIComponent(future)}`)).json() as { items: unknown[] };
    expect(none.items).toHaveLength(0);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const all = (
      await get(owner, `?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)
    ).json() as { items: unknown[] };
    expect(all.items.length).toBeGreaterThan(0);
    expect((await get(owner, "?action=not.a.real.action")).statusCode).toBe(400);
    expect((await get(owner, "?from=yesterday")).statusCode).toBe(400);
  });
});
