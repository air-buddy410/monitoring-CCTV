import { describe, expect, it } from "vitest";
import { loadAgentEnv } from "../src/env";

describe("agent environment", () => {
  it("needs the API URL and gives safe defaults: no loopback, no insecure transport", () => {
    const c = loadAgentEnv({ PANTAU_API_URL: "https://api.example.test" });
    expect(c).toMatchObject({
      apiUrl: "https://api.example.test",
      allowLoopback: false,
      allowInsecure: false,
      logLevel: "info",
    });
    expect(c.dataDir).toMatch(/pantau-agent-data$/);
  });

  it("rejects a missing or malformed API URL without echoing the value", () => {
    expect(() => loadAgentEnv({})).toThrow(/PANTAU_API_URL/);
    try {
      loadAgentEnv({ PANTAU_API_URL: "ftp://user:secret-pw@x" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/PANTAU_API_URL/);
      expect((e as Error).message).not.toContain("secret-pw");
    }
  });

  it("the lab flags are opt-in and only the literal string true turns them on", () => {
    const base = { PANTAU_API_URL: "https://api.example.test" };
    expect(loadAgentEnv({ ...base, PANTAU_ALLOW_LOOPBACK: "true" }).allowLoopback).toBe(true);
    for (const v of ["1", "yes", "TRUE", "", "false"])
      expect(loadAgentEnv({ ...base, PANTAU_ALLOW_LOOPBACK: v }).allowLoopback, v).toBe(false);
    expect(loadAgentEnv({ ...base, PANTAU_ALLOW_INSECURE: "true" }).allowInsecure).toBe(true);
  });

  it("reads the data directory, the agent name and the optional WebSocket origin", () => {
    const c = loadAgentEnv({
      PANTAU_API_URL: "https://a.test",
      PANTAU_AGENT_DATA_DIR: "/var/lib/pantau",
      PANTAU_AGENT_NAME: "Mini PC",
      PANTAU_WS_URL: "wss://ws.a.test",
    });
    expect(c).toMatchObject({ dataDir: "/var/lib/pantau", name: "Mini PC", wsUrl: "wss://ws.a.test" });
  });

  it("local setup page: loopback and port 8780 by default, both overridable", () => {
    const base = { PANTAU_API_URL: "https://a.test" };
    expect(loadAgentEnv(base)).toMatchObject({ localBind: "127.0.0.1", localPort: 8780 });
    expect(
      loadAgentEnv({ ...base, PANTAU_LOCAL_BIND: "192.168.1.10", PANTAU_LOCAL_PORT: "9000" }),
    ).toMatchObject({
      localBind: "192.168.1.10",
      localPort: 9000,
    });
    expect(() => loadAgentEnv({ ...base, PANTAU_LOCAL_PORT: "99999" })).toThrow(/PANTAU_LOCAL_PORT/);
    expect(
      loadAgentEnv({ ...base, PANTAU_LOCAL_TLS_CERT: "/c.pem", PANTAU_LOCAL_TLS_KEY: "/k.pem" }),
    ).toMatchObject({
      localTlsCert: "/c.pem",
      localTlsKey: "/k.pem",
    });
  });
});
