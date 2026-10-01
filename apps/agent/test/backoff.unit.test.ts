import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/backoff";

describe("reconnect backoff (PRD 9.2: exponential 1 s to 60 s, with jitter)", () => {
  it("starts at one second and doubles when there is no jitter effect", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, {}, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000,
    ]);
  });

  it("caps at 60 seconds however many attempts have failed", () => {
    const mid = () => 0.5;
    for (const n of [6, 7, 20, 100, 1000, 100000]) expect(backoffDelay(n, {}, mid)).toBe(60000);
  });

  it("stays inside [1 s, 60 s] for every attempt and every jitter draw", () => {
    for (let n = 0; n < 200; n++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999, 1]) {
        const d = backoffDelay(n, {}, () => r);
        expect(d, `attempt ${n} rand ${r}`).toBeGreaterThanOrEqual(1000);
        expect(d, `attempt ${n} rand ${r}`).toBeLessThanOrEqual(60000);
        expect(Number.isFinite(d)).toBe(true);
      }
    }
  });

  it("jitter spreads the delays: different draws give different delays in the middle of the range", () => {
    const seen = new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => backoffDelay(4, {}, () => r)));
    expect(seen.size).toBeGreaterThan(3);
    const lo = backoffDelay(4, {}, () => 0);
    const hi = backoffDelay(4, {}, () => 1);
    expect(hi / lo).toBeGreaterThan(1.3);
    expect(hi / lo).toBeLessThan(1.7);
  });

  it("is never shorter than the previous attempt for the same draw (until the cap)", () => {
    for (const r of [0, 0.5, 1]) {
      let prev = 0;
      for (let n = 0; n < 12; n++) {
        const d = backoffDelay(n, {}, () => r);
        expect(d).toBeGreaterThanOrEqual(prev);
        prev = d;
      }
    }
  });

  it("negative or fractional attempts are treated as the first", () => {
    expect(backoffDelay(-5, {}, () => 0.5)).toBe(1000);
    expect(backoffDelay(0.7, {}, () => 0.5)).toBe(1000);
  });

  it("honours custom bounds", () => {
    expect(backoffDelay(0, { baseMs: 10, maxMs: 40 }, () => 0.5)).toBe(10);
    expect(backoffDelay(10, { baseMs: 10, maxMs: 40 }, () => 0.5)).toBe(40);
  });
});
