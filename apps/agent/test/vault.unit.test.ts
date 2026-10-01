import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileVault } from "../src/vault";

const SENTINEL_USER = "dummy-admin";
const SENTINEL_PASS = "Dummy-Sentinel-Pw-7391!";
const fresh = () => mkdtempSync(join(tmpdir(), "pantau-vault-"));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("agent credential vault (AES-256-GCM, key in a 0600 file)", () => {
  it("round-trips credentials and persists across instances", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: SENTINEL_USER, password: SENTINEL_PASS });
    expect(v.get("dev-1")).toEqual({ username: SENTINEL_USER, password: SENTINEL_PASS });
    expect(FileVault.open(dir).get("dev-1")).toEqual({ username: SENTINEL_USER, password: SENTINEL_PASS });
    expect(v.get("dev-2")).toBeNull();
    expect(v.has("dev-1")).toBe(true);
    expect(v.keys()).toEqual(["dev-1"]);
  });

  it("the key file and the data file are 0600 and the directory 0700", () => {
    const dir = fresh();
    const v = FileVault.open(join(dir, "nested", "vault"));
    v.put("dev-1", { username: "u", password: "p" });
    expect(mode(join(dir, "nested", "vault"))).toBe(0o700);
    expect(mode(join(dir, "nested", "vault", "vault.key"))).toBe(0o600);
    expect(mode(join(dir, "nested", "vault", "vault.json"))).toBe(0o600);
  });

  it("nothing readable on disk contains the username or the password", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: SENTINEL_USER, password: SENTINEL_PASS });
    for (const f of ["vault.json", "vault.key"]) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toContain(SENTINEL_PASS);
      expect(text, f).not.toContain(SENTINEL_USER);
    }
  });

  it("encrypts with a fresh nonce each time: the same credentials never give the same blob", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: "u", password: "p" });
    v.put("dev-2", { username: "u", password: "p" });
    const data = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")) as {
      entries: Record<string, string>;
    };
    expect(data.entries["dev-1"]).not.toBe(data.entries["dev-2"]);
  });

  it("a modified blob is detected, not decrypted to garbage", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: "u", password: "p" });
    const file = join(dir, "vault.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, string> };
    const blob = data.entries["dev-1"] as string;
    const parts = blob.split(".");
    const ct = Buffer.from(parts[3] as string, "base64url");
    ct[0] = (ct[0] as number) ^ 1;
    parts[3] = ct.toString("base64url");
    data.entries["dev-1"] = parts.join(".");
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    expect(() => FileVault.open(dir).get("dev-1")).toThrow(/vault/i);
  });

  it("a blob moved to another device key is refused (the device key is authenticated)", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: "u1", password: "p1" });
    v.put("dev-2", { username: "u2", password: "p2" });
    const file = join(dir, "vault.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { entries: Record<string, string> };
    data.entries["dev-2"] = data.entries["dev-1"] as string;
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    expect(() => FileVault.open(dir).get("dev-2")).toThrow(/vault/i);
  });

  it("a different key file cannot open existing data", () => {
    const a = fresh();
    const b = fresh();
    FileVault.open(a).put("dev-1", { username: "u", password: "p" });
    FileVault.open(b);
    writeFileSync(join(a, "vault.key"), readFileSync(join(b, "vault.key")), { mode: 0o600 });
    expect(() => FileVault.open(a).get("dev-1")).toThrow(/vault/i);
  });

  it("refuses to start when the key file is readable by group or others", () => {
    const dir = fresh();
    FileVault.open(dir);
    chmodSync(join(dir, "vault.key"), 0o644);
    expect(() => FileVault.open(dir)).toThrow(/0600|permission/i);
    chmodSync(join(dir, "vault.key"), 0o640);
    expect(() => FileVault.open(dir)).toThrow(/0600|permission/i);
  });

  it("refuses a key file of the wrong length", () => {
    const dir = fresh();
    FileVault.open(dir);
    writeFileSync(join(dir, "vault.key"), Buffer.alloc(8).toString("base64"), { mode: 0o600 });
    expect(() => FileVault.open(dir)).toThrow(/key/i);
  });

  it("delete removes the entry from disk", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: "u", password: "p" });
    v.delete("dev-1");
    expect(v.has("dev-1")).toBe(false);
    expect(FileVault.open(dir).get("dev-1")).toBeNull();
    expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain("dev-1");
  });

  it("errors never contain the credentials", () => {
    const dir = fresh();
    const v = FileVault.open(dir);
    v.put("dev-1", { username: SENTINEL_USER, password: SENTINEL_PASS });
    const file = join(dir, "vault.json");
    writeFileSync(file, "{not json", { mode: 0o600 });
    try {
      FileVault.open(dir).get("dev-1");
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SENTINEL_PASS);
    }
  });
});
