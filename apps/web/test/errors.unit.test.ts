import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { describeError, isForbidden, isRateLimited } from "../src/lib/errors";

describe("describeError", () => {
  it("explains rate limiting with the wait time from the server", () => {
    const m = describeError(new ApiError(429, "rate_limited", 42));
    expect(m.title).toMatch(/terlalu banyak/i);
    expect(m.hint).toContain("42 detik");
  });
  it("maps device failures to specific, actionable copy", () => {
    expect(describeError(new ApiError(422, "device_auth_failed")).title).toMatch(/menolak/);
    expect(describeError(new ApiError(504, "device_timeout")).title).toMatch(/tepat waktu/);
    expect(describeError(new ApiError(422, "target_not_allowed")).hint).toMatch(/IP privat/);
    expect(describeError(new ApiError(502, "snapshot_invalid_image")).title).toMatch(/JPEG/);
  });
  it("handles session and permission errors", () => {
    expect(describeError(new ApiError(401, "unauthenticated")).title).toMatch(/Sesi berakhir/);
    expect(describeError(new ApiError(403, "forbidden")).title).toMatch(/Peran/);
    expect(isForbidden(new ApiError(403, "x"))).toBe(true);
    expect(isRateLimited(new ApiError(429, "x"))).toBe(true);
    expect(isForbidden(new Error("x"))).toBe(false);
  });
  it("falls back by status for unknown codes and never echoes server text", () => {
    expect(describeError(new ApiError(500, "weird")).title).toMatch(/galat/);
    expect(describeError(new ApiError(404, "weird")).title).toMatch(/tidak ditemukan/);
    const m = describeError(new ApiError(418, "secret-password-hunter2"));
    expect(JSON.stringify(m)).not.toContain("hunter2");
  });
  it("treats non-API errors generically", () => {
    expect(describeError(new TypeError("boom")).title).toMatch(/tidak dikenali/);
  });
});
