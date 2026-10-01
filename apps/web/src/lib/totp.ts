/** The shared secret in an otpauth URI, for manual entry in an authenticator app. Null if the URI has none. */
export function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

/** Groups of four for reading aloud or typing: "ABCD EFGH". */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/** A 6-digit authenticator code, with the spaces people type removed. Null when it cannot be one. */
export function normalizeTotp(raw: string): string | null {
  const v = raw.replace(/\s+/g, "");
  return /^\d{6}$/.test(v) ? v : null;
}

/** Backup codes look like "abcde-fghij"; case and stray spaces are forgiven. Null when empty. */
export function normalizeBackup(raw: string): string | null {
  const v = raw.trim().replace(/\s+/g, "");
  return v.length >= 8 ? v : null;
}
