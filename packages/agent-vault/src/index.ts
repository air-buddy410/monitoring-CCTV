import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";

/**
 * Agent-side credential vault (PRD section 11): camera credentials are encrypted AES-256-GCM on the
 * agent, with the key read from a `0600` file owned by the agent user. Nothing here ever sends a
 * secret to the cloud; the wire protocol carries metadata only (PRD section 9.2).
 */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEAL_VERSION = "v1";

export class VaultKeyError extends Error {
  readonly code = "vault_key_error";
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

export class VaultIntegrityError extends Error {
  readonly code = "vault_integrity_error";
  constructor(message: string) {
    super(message);
    this.name = "VaultIntegrityError";
  }
}

export interface DeviceCredential {
  username: string;
  password: string;
}

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Group or other permission bits mean another account on the agent host can read the key, which would
 * undo the encryption entirely, so a key file that is not owner-only is refused rather than used.
 */
function assertOwnerOnly(path: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new VaultKeyError(`vault key path ${path} is not a regular file`);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new VaultKeyError(`vault key file ${path} must be owner-only, found mode 0${mode.toString(8)}`);
  }
  const me = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (me !== undefined && st.uid !== me) {
    throw new VaultKeyError(`vault key file ${path} is owned by uid ${st.uid}, not the agent user`);
  }
}

export function loadVaultKey(path: string): Buffer {
  assertOwnerOnly(path);
  const raw = readFileSync(path, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new VaultKeyError(`vault key file ${path} must hold ${KEY_BYTES} base64 bytes`);
  }
  return key;
}

/** Create the key with mode `0600` from the first byte, so it is never briefly world-readable. */
export function writeVaultKey(path: string, key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new VaultKeyError(`vault key must be ${KEY_BYTES} bytes`);
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, `${key.toString("base64")}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/**
 * Create the key only if it is absent. `wx` fails on an existing file, so two processes starting at
 * once cannot end up with different keys and unreadable credentials.
 */
export function createVaultKeyIfAbsent(path: string): { key: Buffer; created: boolean } {
  const key = generateVaultKey();
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${key.toString("base64")}\n`);
    } finally {
      closeSync(fd);
    }
    return { key, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { key: loadVaultKey(path), created: false };
  }
}

/**
 * The device key is bound into the ciphertext as additional authenticated data, so a sealed blob
 * moved to a different device record fails to open instead of silently decrypting to the wrong camera.
 */
export function sealCredential(key: Buffer, deviceKey: string, cred: DeviceCredential): string {
  if (key.length !== KEY_BYTES) throw new VaultKeyError(`vault key must be ${KEY_BYTES} bytes`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(deviceKey, "utf8"));
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(cred), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEAL_VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function openCredential(key: Buffer, deviceKey: string, sealed: string): DeviceCredential {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) {
    throw new VaultIntegrityError("sealed credential has an unknown format");
  }
  const iv = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  const ct = Buffer.from(parts[3] ?? "", "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new VaultIntegrityError("sealed credential has a malformed nonce or tag");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(deviceKey, "utf8"));
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // a wrong key or a tampered record must not be reported as a usable credential
    throw new VaultIntegrityError("sealed credential failed authentication");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new VaultIntegrityError("sealed credential did not hold JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as DeviceCredential).username !== "string" ||
    typeof (parsed as DeviceCredential).password !== "string"
  ) {
    throw new VaultIntegrityError("sealed credential did not hold a username and password");
  }
  return { username: (parsed as DeviceCredential).username, password: (parsed as DeviceCredential).password };
}

/** Replace any known secret with a placeholder, for the rare case a value must be logged at all. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Proof helper for the M2 acceptance test: a payload that would carry a vault secret to the cloud (or
 * into a log) is detectable before it is sent.
 */
export function containsSecret(text: string, secrets: Iterable<string>): boolean {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (text.includes(secret)) return true;
  }
  return false;
}

interface VaultFile {
  version: 1;
  records: Record<string, string>;
}

export interface CredentialVaultOptions {
  key: Buffer;
  filePath?: string;
}

/**
 * Owner-only, atomically replaced credential store. `list()` and `toJSON()` expose device keys only,
 * so a caller cannot accidentally serialize secrets into an inventory message or a log line.
 */
export class CredentialVault {
  private readonly key: Buffer;
  private readonly filePath: string | undefined;
  private readonly records = new Map<string, string>();

  constructor(options: CredentialVaultOptions) {
    if (options.key.length !== KEY_BYTES) {
      throw new VaultKeyError(`vault key must be ${KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(options.key);
    this.filePath = options.filePath;
    if (this.filePath) this.load();
  }

  private load(): void {
    const path = this.filePath as string;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new VaultIntegrityError(`vault file ${path} is not valid JSON`);
    }
    const file = parsed as VaultFile;
    if (file?.version !== 1 || typeof file.records !== "object" || file.records === null) {
      throw new VaultIntegrityError(`vault file ${path} has an unknown shape`);
    }
    for (const [deviceKey, sealed] of Object.entries(file.records)) {
      if (typeof sealed !== "string") throw new VaultIntegrityError(`vault file ${path} is malformed`);
      this.records.set(deviceKey, sealed);
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const file: VaultFile = { version: 1, records: Object.fromEntries(this.records) };
    // a partial write during a power cut would lose every credential, so write beside then rename
    const tmp = `${this.filePath}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }

  put(deviceKey: string, cred: DeviceCredential): void {
    this.records.set(deviceKey, sealCredential(this.key, deviceKey, cred));
    this.persist();
  }

  get(deviceKey: string): DeviceCredential | undefined {
    const sealed = this.records.get(deviceKey);
    if (sealed === undefined) return undefined;
    return openCredential(this.key, deviceKey, sealed);
  }

  has(deviceKey: string): boolean {
    return this.records.has(deviceKey);
  }

  delete(deviceKey: string): boolean {
    const removed = this.records.delete(deviceKey);
    if (removed) this.persist();
    return removed;
  }

  /** Device keys only. Never returns a secret. */
  list(): string[] {
    return [...this.records.keys()].sort();
  }

  /** Secrets never reach a log or an error report through this object. */
  toJSON(): { version: number; devices: string[] } {
    return { version: 1, devices: this.list() };
  }
}

/** Constant-time compare for callers that check a presented secret against a stored one. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
