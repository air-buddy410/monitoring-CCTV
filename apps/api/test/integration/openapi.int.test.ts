import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers";

describe("OpenAPI", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env.close());

  it("documents every MVP-0 endpoint with schemas", async () => {
    const res = await env.built.app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toMatch(/^3\./);
    const expected: [string, string][] = [
      ["/healthz", "get"],
      ["/readyz", "get"],
      ["/v1/sites", "post"],
      ["/v1/sites", "get"],
      ["/v1/devices", "post"],
      ["/v1/devices", "get"],
      ["/v1/devices/{id}", "get"],
      ["/v1/cameras", "get"],
      ["/v1/cameras/{id}", "get"],
      ["/v1/cameras/{id}/snapshot", "post"],
      ["/v1/audit", "get"],
      ["/v1/sites/{id}", "get"],
      ["/v1/sites/{id}", "patch"],
      ["/v1/sites/{id}", "delete"],
      ["/v1/cameras/{id}", "patch"],
      ["/v1/grants", "get"],
      ["/v1/grants", "post"],
      ["/v1/grants/{id}", "delete"],
      ["/v1/sites/{id}/enrollments", "post"],
      ["/v1/agents/enroll", "post"],
      ["/v1/agents", "get"],
      ["/v1/agents/{id}", "get"],
      ["/v1/agents/{id}/revoke", "post"],
      ["/v1/agents/{id}", "delete"],
    ];
    for (const [path, method] of expected) {
      expect(doc.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
    const post = doc.paths["/v1/devices"]?.post as {
      requestBody?: unknown;
      responses?: Record<string, unknown>;
    };
    expect(post.requestBody).toBeDefined();
    expect(post.responses?.["201"]).toBeDefined();
    expect(post.responses?.["404"]).toBeDefined();
  });

  it("health endpoints work, readyz checks the database", async () => {
    expect((await env.built.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await env.built.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});
