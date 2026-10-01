import { afterAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers";

describe("/healthz and /readyz", () => {
  const envs: TestEnv[] = [];
  const make = async (...a: Parameters<typeof createTestEnv>) => {
    const e = await createTestEnv(...a);
    envs.push(e);
    return e;
  };
  afterAll(async () => {
    await Promise.all(envs.map((e) => e.close().catch(() => undefined)));
  });
  const get = (e: TestEnv, url: string) => e.built.app.inject({ method: "GET", url });

  it("liveness never touches the database and needs no session", async () => {
    const e = await make();
    await e.built.handle.pool.end();
    const res = await get(e, "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("readiness is 200 with a database and lists which checks ran", async () => {
    const e = await make();
    const res = await get(e, "/readyz");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: ["db"] });
  });

  it("readiness is 503 when the database is gone, and says which check failed without leaking details", async () => {
    const e = await make();
    await e.built.handle.pool.end();
    const res = await get(e, "/readyz");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", failed: ["db"] });
    expect(res.body).not.toMatch(/postgres|password|ECONN/i);
  });

  it("readiness is 503 within the deadline when a check hangs, instead of hanging too", async () => {
    const e = await make({ READINESS_TIMEOUT_MS: "300" });
    e.built.readiness.register("slow", () => new Promise(() => undefined));
    const started = Date.now();
    const res = await get(e, "/readyz");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", failed: ["slow"] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("extra checks (the pg-boss seam) take part: green when they pass, 503 when they fail", async () => {
    const e = await make();
    let ok = true;
    e.built.readiness.register("queue", async () => {
      if (!ok) throw new Error("queue down: secret-connection-string");
    });
    const up = await get(e, "/readyz");
    expect(up.statusCode).toBe(200);
    expect((up.json() as { checks: string[] }).checks).toEqual(["db", "queue"]);
    ok = false;
    const down = await get(e, "/readyz");
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: "unavailable", failed: ["queue"] });
    expect(down.body).not.toContain("secret-connection-string");
  });

  it("both endpoints are public and appear in the OpenAPI document", async () => {
    const e = await make();
    const doc = (await get(e, "/docs/json")).json() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
  });
});
