import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTIONS } from "@pantau/contracts";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

describe("audit action catalogue", () => {
  it("every literal action passed to writeAudit is in AUDIT_ACTIONS (no ad-hoc action names)", () => {
    const used = new Set<string>();
    for (const f of files(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/writeAudit(?:System)?\(\s*[a-zA-Z.]+,\s*[a-zA-Z.]+,\s*"([a-z0-9_.]+)"/g))
        used.add(m[1] as string);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const a of used) expect(AUDIT_ACTIONS, `unknown audit action ${a}`).toContain(a);
  });

  it("names are dotted lowercase and unique", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const a of AUDIT_ACTIONS) expect(a).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
  });
});
