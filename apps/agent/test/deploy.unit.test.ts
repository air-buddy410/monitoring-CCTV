import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGo2rtcConfig } from "../src/go2rtc";

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../deploy/agent/${f}`, import.meta.url)), "utf8");
const FILES = ["Dockerfile", "compose.yml", "pantau-agent.service", "install.sh"];

describe("agent deployment files (static checks: no image is built here)", () => {
  it("install.sh is valid bash", () => {
    const path = fileURLToPath(new URL("../../../deploy/agent/install.sh", import.meta.url));
    expect(() => execFileSync("bash", ["-n", path])).not.toThrow();
  });
  it("holds no secret, no real address and no wildcard listener", () => {
    for (const f of FILES) {
      const t = read(f);
      expect(t, f).not.toContain("0.0.0.0");
      expect(t, f).not.toMatch(/Dummy-|pae_|pat_|password\s*[:=]\s*\S/i);
      expect(t, f).not.toMatch(/—|–/);
    }
  });
  it("docker image runs unprivileged, publishes no port and defaults to loopback", () => {
    const d = read("Dockerfile");
    expect(d).toMatch(/^USER 10001:10001$/m);
    expect(d).not.toMatch(/^EXPOSE/m);
    expect(d).toContain("PANTAU_LOCAL_BIND=127.0.0.1");
    expect(d).not.toMatch(/1984|8554|8555/);
  });
  it("compose uses host networking only to reach the LAN, with a locked-down container", () => {
    const c = read("compose.yml");
    expect(c).toMatch(/network_mode:\s*host/);
    expect(c).not.toMatch(/^\s*ports:/m);
    expect(c).toMatch(/read_only:\s*true/);
    expect(c).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(c).toContain("no-new-privileges:true");
    expect(c).toContain("PANTAU_LOCAL_BIND: 127.0.0.1");
  });
  it("systemd unit drops privileges and filesystem access", () => {
    const u = read("pantau-agent.service");
    for (const k of [
      "User=pantau-agent",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "PrivateTmp=true",
      "UMask=0077",
      "CapabilityBoundingSet=",
    ])
      expect(u).toContain(k);
  });
  it("installer demands https, never stores the enrollment token and writes no password", () => {
    const s = read("install.sh");
    expect(s).toContain("https://*");
    expect(s).toContain("read -rsp");
    const envBlock = /cat >\/etc\/pantau-agent\/agent\.env <<ENV([\s\S]*?)\nENV/.exec(s)?.[1] ?? "";
    expect(envBlock).toContain("PANTAU_API_URL");
    expect(envBlock).not.toMatch(/TOKEN|PASSWORD/i);
  });
  it("the go2rtc config the agent writes is loopback only", () => {
    expect(buildGo2rtcConfig()).not.toContain("0.0.0.0");
  });
});
