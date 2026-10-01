import { describe, expect, it } from "vitest";
import { groupSecret, normalizeBackup, normalizeTotp, secretFromUri } from "../src/lib/totp";

describe("totp helpers", () => {
  it("reads the secret from an otpauth URI and tolerates garbage", () => {
    expect(secretFromUri("otpauth://totp/PANTAU:a%40b.test?secret=JBSWY3DPEHPK3PXP&issuer=PANTAU")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(secretFromUri("otpauth://totp/x")).toBeNull();
    expect(secretFromUri("not a uri")).toBeNull();
  });

  it("groups the key in fours for typing", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    expect(groupSecret("ABC")).toBe("ABC");
  });

  it("accepts only six digits, forgiving the spaces people type", () => {
    expect(normalizeTotp("123456")).toBe("123456");
    expect(normalizeTotp(" 123 456 ")).toBe("123456");
    for (const bad of ["12345", "1234567", "12345a", "", "１２３４５６"])
      expect(normalizeTotp(bad), bad).toBeNull();
  });

  it("accepts backup codes of reasonable length and trims them", () => {
    expect(normalizeBackup("  abcde-fghij ")).toBe("abcde-fghij");
    expect(normalizeBackup("short")).toBeNull();
    expect(normalizeBackup("")).toBeNull();
  });
});
