import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialVault,
  containsSecret,
  createVaultKeyIfAbsent,
  generateVaultKey,
  loadVaultKey,
  openCredential,
  redact,
  sealCredential,
  secretEquals,
  VaultIntegrityError,
  VaultKeyError,
  writeVaultKey,
} from "../src/index";

const SECRET = "correct-horse-battery-staple";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pantau-vault-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("agent credential vault (PRD section 11)", () => {
  it("round-trips a credential without storing the password in cleartext", () => {
    const key = generateVaultKey();
    const sealed = sealCredential(key, "10.0.0.5:80", { username: "onvif", password: SECRET });
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain("onvif");
    expect(openCredential(key, "10.0.0.5:80", sealed)).toEqual({ username: "onvif", password: SECRET });
  });

  it("binds the ciphertext to its device, so a blob moved to another device will not open", () => {
    const key = generateVaultKey();
    const sealed = sealCredential(key, "10.0.0.5:80", { username: "onvif", password: SECRET });
    expect(() => openCredential(key, "10.0.0.9:80", sealed)).toThrow(VaultIntegrityError);
  });

  it("refuses a tampered ciphertext instead of returning a wrong credential", () => {
    const key = generateVaultKey();
    const sealed = sealCredential(key, "d1", { username: "onvif", password: SECRET });
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3] as string, "base64");
    ct[0] = (ct[0] as number) ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => openCredential(key, "d1", parts.join("."))).toThrow(VaultIntegrityError);
  });

  it("refuses a credential sealed under a different key", () => {
    const sealed = sealCredential(generateVaultKey(), "d1", { username: "a", password: SECRET });
    expect(() => openCredential(generateVaultKey(), "d1", sealed)).toThrow(VaultIntegrityError);
  });

  it("rejects a malformed sealed value rather than guessing", () => {
    const key = generateVaultKey();
    for (const bad of ["", "v1", "v2.aaaa.bbbb.cccc", "v1.!!.!!.!!"]) {
      expect(() => openCredential(key, "d1", bad)).toThrow(VaultIntegrityError);
    }
  });

  it("uses a fresh nonce per seal, so the same credential never repeats its ciphertext", () => {
    const key = generateVaultKey();
    const a = sealCredential(key, "d1", { username: "onvif", password: SECRET });
    const b = sealCredential(key, "d1", { username: "onvif", password: SECRET });
    expect(a).not.toEqual(b);
  });

  it("writes the key file owner-only and refuses a key that others could read", () => {
    const path = join(dir, "vault.key");
    writeVaultKey(path, generateVaultKey());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadVaultKey(path).length).toBe(32);

    const loose = join(dir, "loose.key");
    writeFileSync(loose, `${generateVaultKey().toString("base64")}\n`, { mode: 0o644 });
    expect(() => loadVaultKey(loose)).toThrow(VaultKeyError);
  });

  it("rejects a key file of the wrong length instead of padding it", () => {
    const path = join(dir, "short.key");
    writeFileSync(path, "AAAA\n", { mode: 0o600 });
    expect(() => loadVaultKey(path)).toThrow(VaultKeyError);
  });

  it("creates the key only when absent, so a restart keeps reading the same credentials", () => {
    const path = join(dir, "vault.key");
    const first = createVaultKeyIfAbsent(path);
    expect(first.created).toBe(true);
    const second = createVaultKeyIfAbsent(path);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });
});

describe("CredentialVault store", () => {
  it("keeps secrets out of its listing and its JSON form", () => {
    const vault = new CredentialVault({ key: generateVaultKey() });
    vault.put("10.0.0.5:80", { username: "onvif", password: SECRET });
    expect(vault.list()).toEqual(["10.0.0.5:80"]);
    const json = JSON.stringify(vault);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("onvif");
    // the JSON form is device keys only, so a caller cannot serialize the sealed records by accident
    expect(JSON.parse(json)).toEqual({ version: 1, devices: ["10.0.0.5:80"] });
  });

  it("survives a restart through its file, and the file holds no cleartext", () => {
    const filePath = join(dir, "vault.json");
    const key = generateVaultKey();
    const vault = new CredentialVault({ key, filePath });
    vault.put("cam-1", { username: "onvif", password: SECRET });
    expect(vault.get("cam-1")).toEqual({ username: "onvif", password: SECRET });

    const onDisk = readFileSync(filePath, "utf8");
    expect(onDisk).not.toContain(SECRET);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    const reopened = new CredentialVault({ key, filePath });
    expect(reopened.get("cam-1")).toEqual({ username: "onvif", password: SECRET });
    expect(reopened.list()).toEqual(["cam-1"]);
  });

  it("will not read a vault file written under another key", () => {
    const filePath = join(dir, "vault.json");
    new CredentialVault({ key: generateVaultKey(), filePath }).put("cam-1", {
      username: "onvif",
      password: SECRET,
    });
    const other = new CredentialVault({ key: generateVaultKey(), filePath });
    expect(() => other.get("cam-1")).toThrow(VaultIntegrityError);
  });

  it("forgets a deleted device and reports an unknown device as absent", () => {
    const vault = new CredentialVault({ key: generateVaultKey() });
    vault.put("cam-1", { username: "onvif", password: SECRET });
    expect(vault.has("cam-1")).toBe(true);
    expect(vault.delete("cam-1")).toBe(true);
    expect(vault.delete("cam-1")).toBe(false);
    expect(vault.get("cam-1")).toBeUndefined();
    expect(vault.list()).toEqual([]);
  });

  it("refuses a key of the wrong size at construction", () => {
    expect(() => new CredentialVault({ key: Buffer.alloc(16) })).toThrow(VaultKeyError);
  });
});

describe("secret hygiene helpers", () => {
  it("redacts every known secret from a message", () => {
    expect(redact(`user=onvif pass=${SECRET}`, [SECRET, "onvif"])).toBe("user=[redacted] pass=[redacted]");
  });

  it("detects a secret smuggled into an outbound payload", () => {
    const frame = JSON.stringify({ type: "inventory.sync", payload: { password: SECRET } });
    expect(containsSecret(frame, [SECRET])).toBe(true);
    expect(containsSecret(JSON.stringify({ payload: { name: "Cam 1" } }), [SECRET])).toBe(false);
  });

  it("compares secrets without leaking length through an exception", () => {
    expect(secretEquals(SECRET, SECRET)).toBe(true);
    expect(secretEquals(SECRET, "other")).toBe(false);
    expect(secretEquals(SECRET, `${SECRET}x`)).toBe(false);
  });
});
