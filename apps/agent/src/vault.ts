import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Credentials {
  username: string;
  password: string;
}

export class VaultError extends Error {
  constructor(message: string) {
    super(`vault: ${message}`);
    this.name = "VaultError";
  }
}

interface VaultFile {
  version: 1;
  entries: Record<string, string>;
}

const KEY_FILE = "vault.key";
const DATA_FILE = "vault.json";

/**
 * Device credentials, encrypted at rest with AES-256-GCM (PRD section 11). The key lives in its own 0600 file,
 * and each entry authenticates its device key, so a blob cannot be moved to another device. Credentials never
 * leave this process: the cloud receives metadata only.
 */
export class FileVault {
  private constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {}

  static open(dir: string): FileVault {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const keyPath = join(dir, KEY_FILE);
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    if ((statSync(keyPath).mode & 0o077) !== 0) {
      throw new VaultError(`${KEY_FILE} must be mode 0600 (no access for group or others)`);
    }
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) throw new VaultError("key file must hold 32 bytes");
    return new FileVault(dir, key);
  }

  private read(): VaultFile {
    const path = join(this.dir, DATA_FILE);
    if (!existsSync(path)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
      if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null)
        throw new Error("shape");
      return parsed;
    } catch {
      throw new VaultError("data file is unreadable");
    }
  }

  private write(data: VaultFile): void {
    const path = join(this.dir, DATA_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  put(deviceKey: string, creds: Credentials): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(deviceKey));
    const ct = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
    const blob = [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
    const data = this.read();
    data.entries[deviceKey] = blob;
    this.write(data);
  }

  get(deviceKey: string): Credentials | null {
    const blob = this.read().entries[deviceKey];
    if (blob === undefined) return null;
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1" || !iv || !tag || !ct) throw new VaultError("entry has an unknown format");
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      d.setAAD(Buffer.from(deviceKey));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      const plain = Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
      return JSON.parse(plain) as Credentials;
    } catch {
      throw new VaultError("entry cannot be decrypted (wrong key or modified data)");
    }
  }

  has(deviceKey: string): boolean {
    return this.read().entries[deviceKey] !== undefined;
  }

  keys(): string[] {
    return Object.keys(this.read().entries).sort();
  }

  delete(deviceKey: string): void {
    const data = this.read();
    delete data.entries[deviceKey];
    this.write(data);
  }
}
