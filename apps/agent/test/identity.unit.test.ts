import { createPublicKey } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enroll, loadIdentity } from "../src/identity";

const ENROLL_TOKEN = "pae_" + "E".repeat(43);
const AGENT_TOKEN = "pat_" + "A".repeat(43);
const fresh = () => mkdtempSync(join(tmpdir(), "pantau-id-"));
const mode = (p: string) => statSync(p).mode & 0o777;

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("agent enrollment on the agent side", () => {
  it("generates an Ed25519 key pair, sends the public key and the enrollment token in the header, stores the identity", async () => {
    const dir = fresh();
    const seen: { url?: string; init?: RequestInit } = {};
    const id = await enroll({
      apiUrl: "https://api.example.test",
      enrollToken: ENROLL_TOKEN,
      name: "Mini PC",
      dir,
      hostname: "mini-pc",
      agentVersion: "0.1.0",
      fetchFn: fakeFetch(
        201,
        { agentId: "agt_1", siteId: "site_1", agentToken: AGENT_TOKEN, websocketPath: "/agent" },
        seen,
      ),
    });
    expect(seen.url).toBe("https://api.example.test/v1/agent/enroll");
    const headers = new Headers(seen.init?.headers);
    expect(headers.get("authorization")).toBe(`Enroll ${ENROLL_TOKEN}`);
    const body = JSON.parse(String(seen.init?.body));
    expect(body).toMatchObject({ name: "Mini PC", hostname: "mini-pc", agentVersion: "0.1.0" });
    const key = createPublicKey({ key: Buffer.from(body.publicKey, "base64"), format: "der", type: "spki" });
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(JSON.stringify(body)).not.toContain(ENROLL_TOKEN);
    expect(id).toMatchObject({
      agentId: "agt_1",
      siteId: "site_1",
      agentToken: AGENT_TOKEN,
      apiUrl: "https://api.example.test",
    });
    expect(loadIdentity(dir)).toEqual(id);
  });

  it("identity and private key files are 0600; the enrollment token is never written to disk", async () => {
    const dir = fresh();
    await enroll({
      apiUrl: "https://api.example.test",
      enrollToken: ENROLL_TOKEN,
      name: "x",
      dir,
      fetchFn: fakeFetch(201, {
        agentId: "agt_1",
        siteId: "site_1",
        agentToken: AGENT_TOKEN,
        websocketPath: "/agent",
      }),
    });
    for (const f of ["identity.json", "agent.key"]) expect(mode(join(dir, f)), f).toBe(0o600);
    for (const f of readdirSync(dir).filter((x) => statSync(join(dir, x)).isFile())) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toContain(ENROLL_TOKEN);
    }
    expect(readFileSync(join(dir, "agent.key"), "utf8")).toContain("PRIVATE KEY");
  });

  it("a refused enrollment throws a coded error and leaves no identity behind", async () => {
    const dir = fresh();
    await expect(
      enroll({
        apiUrl: "https://api.example.test",
        enrollToken: ENROLL_TOKEN,
        name: "x",
        dir,
        fetchFn: fakeFetch(401, { code: "enrollment_invalid", title: "x", status: 401, type: "x" }),
      }),
    ).rejects.toMatchObject({ code: "enrollment_invalid" });
    expect(loadIdentity(dir)).toBeNull();
  });

  it("an unreachable server is a coded error, not a crash", async () => {
    const dir = fresh();
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      enroll({ apiUrl: "https://x.test", enrollToken: ENROLL_TOKEN, name: "x", dir, fetchFn: failing }),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects a token that does not look like an enrollment token before any request", async () => {
    const dir = fresh();
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(
      enroll({ apiUrl: "https://x.test", enrollToken: "nope", name: "x", dir, fetchFn: spy }),
    ).rejects.toMatchObject({ code: "enrollment_token_malformed" });
    expect(called).toBe(false);
  });

  it("refuses to enrol an agent that already has an identity", async () => {
    const dir = fresh();
    const ok = fakeFetch(201, {
      agentId: "agt_1",
      siteId: "site_1",
      agentToken: AGENT_TOKEN,
      websocketPath: "/agent",
    });
    await enroll({ apiUrl: "https://x.test", enrollToken: ENROLL_TOKEN, name: "x", dir, fetchFn: ok });
    await expect(
      enroll({ apiUrl: "https://x.test", enrollToken: ENROLL_TOKEN, name: "x", dir, fetchFn: ok }),
    ).rejects.toMatchObject({ code: "already_enrolled" });
  });

  it("refuses to load an identity file readable by others", async () => {
    const dir = fresh();
    await enroll({
      apiUrl: "https://x.test",
      enrollToken: ENROLL_TOKEN,
      name: "x",
      dir,
      fetchFn: fakeFetch(201, {
        agentId: "agt_1",
        siteId: "site_1",
        agentToken: AGENT_TOKEN,
        websocketPath: "/agent",
      }),
    });
    chmodSync(join(dir, "identity.json"), 0o644);
    expect(() => loadIdentity(dir)).toThrow(/0600|permission/i);
  });
});
