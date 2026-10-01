import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTIONS } from "@pantau/contracts";
import { describe, expect, it } from "vitest";

describe("audit action vocabulary", () => {
  it("reserves the viewing/command actions required by PRD F9", () => {
    for (const action of ["live.start", "live.stop", "ptz.command", "playback.start", "playback.stop"]) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("every writeAudit action used in the API source is in the vocabulary", () => {
    const dir = join(import.meta.dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/writeAudit\(\s*tx,\s*t,\s*"([^"]+)"/g)) if (m[1]) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const action of used) expect(AUDIT_ACTIONS, `unknown audit action: ${action}`).toContain(action);
  });
});
