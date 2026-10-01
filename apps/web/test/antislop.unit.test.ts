import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Mechanical antislop checks on shipped UI source (R-02, R-16, R-32, R-33, security hygiene).
const root = new URL("../src/", import.meta.url).pathname;
const files: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(e)) files.push(p);
  }
})(root);
const text = (p: string) => readFileSync(p, "utf8");

describe("UI source hygiene", () => {
  it("has source files to check", () => expect(files.length).toBeGreaterThan(10));
  it("contains no em dash or en dash (R-02)", () => {
    for (const f of files) expect(text(f), f).not.toMatch(new RegExp("[\u2013\u2014]"));
  });
  it("contains no emoji", () => {
    for (const f of files) expect(text(f), f).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it("contains none of the banned buzzwords or generic CTAs (R-15, R-16)", () => {
    const banned =
      /\b(AI Powered|Seamless|Revolutionary|Cutting Edge|Next Generation|Get Started|Learn More|Try Now|Explore|Discover)\b/i;
    for (const f of files) expect(text(f), f).not.toMatch(banned);
  });
  it("never removes the focus outline (R-32)", () => {
    for (const f of files) expect(text(f), f).not.toMatch(/outline\s*:\s*(none|0)\b/);
  });
  it("has no blur or glow decoration (R-10, R-13)", () => {
    for (const f of files) expect(text(f), f).not.toMatch(/backdrop-filter|backdrop-blur|blur\(/);
  });
  it("uses browser storage only for the light/dark preference", () => {
    for (const f of files) {
      const t = text(f);
      if (/localStorage|sessionStorage|document\.cookie/.test(t)) {
        expect(f.endsWith("theme-toggle.tsx") || f.endsWith("layout.tsx"), f).toBe(true);
        expect(t.match(/pantau-theme|const KEY = "pantau-theme"/), f).not.toBeNull();
      }
    }
  });
  it("never places credentials in a URL", () => {
    for (const f of files) expect(text(f), f).not.toMatch(/[?&](password|token|sandi)=/i);
  });
});
