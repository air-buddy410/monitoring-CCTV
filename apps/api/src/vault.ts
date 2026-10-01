import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Vault {
  encrypt(plaintext: string): string;
  decrypt(blob: string): string;
}

/** AES-256-GCM. Blob layout (base64): nonce(12) | tag(16) | ciphertext. */
export function createVault(keyBase64: string): Vault {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString("base64");
    },
    decrypt(blob) {
      const buf = Buffer.from(blob, "base64");
      if (buf.length < 29) throw new Error("invalid vault blob");
      const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
