import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../src/rate-limit";

describe("rate limiter", () => {
  it("allows up to max per window, then blocks with a retry-after", () => {
    let now = 1_000;
    const rl = createRateLimiter({ windowMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) expect(rl.hit("k", 3).allowed).toBe(true);
    const blocked = rl.hit("k", 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });
  it("keys are independent", () => {
    const rl = createRateLimiter({ windowMs: 60_000 });
    rl.hit("a", 1);
    expect(rl.hit("a", 1).allowed).toBe(false);
    expect(rl.hit("b", 1).allowed).toBe(true);
  });
  it("the window resets", () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: 1000, now: () => now });
    rl.hit("k", 1);
    expect(rl.hit("k", 1).allowed).toBe(false);
    now = 1001;
    expect(rl.hit("k", 1).allowed).toBe(true);
  });
  it("memory stays bounded under many distinct keys", () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: 1000, maxKeys: 100, now: () => now });
    for (let i = 0; i < 1000; i++) {
      now += 10;
      rl.hit(`k${i}`, 5);
    }
    expect(rl.size()).toBeLessThanOrEqual(100);
  });
});
