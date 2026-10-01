import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WCAG 2.x relative luminance and contrast ratio, same formula as the antislop-human checker.
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const css = readFileSync(new URL("../src/app/tokens.css", import.meta.url), "utf8");
function block(selector: string): Record<string, string> {
  const m = new RegExp(`${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`missing block ${selector}`);
  return Object.fromEntries(
    [...(m[1] ?? "").matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((x) => [x[1], x[2]]),
  );
}
const themes = {
  light: block(':root[data-theme="light"]'),
  dark: block(':root[data-theme="dark"]'),
} as const;

// [foreground, background, minimum ratio]. 4.5 for text, 3 for non-text boundaries (WCAG 1.4.11).
const PAIRS: [string, string, number][] = [
  ...["bg", "surface", "raised"].flatMap((bg): [string, string, number][] => [
    ["text", bg, 4.5],
    ["muted", bg, 4.5],
    ["accent-text", bg, 4.5],
    ["danger", bg, 4.5],
    ["ok", bg, 4.5],
    ["line", bg, 3],
  ]),
  ["on-accent", "accent", 4.5],
  ["viewer-text", "viewer-bg", 4.5],
];

describe("design tokens meet WCAG AA", () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${name}: ${fg} on ${bg} >= ${min}`, () => {
        expect(t[fg], `token ${fg}`).toBeDefined();
        expect(t[bg], `token ${bg}`).toBeDefined();
        expect(ratio(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("the OS-preference dark block matches the explicit dark theme", () => {
    const m = /prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/.exec(css);
    const auto = Object.fromEntries(
      [...(m?.[1] ?? "").matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((x) => [x[1], x[2]]),
    );
    expect(auto).toEqual(themes.dark);
  });

  it("matches the reference vector of the antislop checker (black on white = 21)", () => {
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(ratio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
