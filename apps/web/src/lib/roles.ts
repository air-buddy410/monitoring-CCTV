export type Role = "owner" | "operator" | "viewer";

// Better Auth organization roles map to the PRD roles (docs/DECISIONS.md D5).
const MAP: Record<string, Role> = { owner: "owner", admin: "operator", member: "viewer" };

export const toRole = (raw: unknown): Role | null => (typeof raw === "string" ? (MAP[raw] ?? null) : null);

export const can = {
  addDevice: (r: Role | null) => r === "owner" || r === "operator",
  snapshot: (r: Role | null) => r === "owner" || r === "operator",
  audit: (r: Role | null) => r === "owner",
};

export const ROLE_LABEL: Record<Role, string> = { owner: "Pemilik", operator: "Operator", viewer: "Penonton" };
