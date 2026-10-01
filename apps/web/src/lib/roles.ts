export type Role = "owner" | "noc" | "operator" | "viewer";

// Better Auth organization roles map to the PRD roles (docs/DECISIONS.md D5, D20).
const MAP: Record<string, Role> = { owner: "owner", admin: "operator", member: "viewer", noc: "noc" };

export const toRole = (raw: unknown): Role | null => (typeof raw === "string" ? (MAP[raw] ?? null) : null);

export const can = {
  addDevice: (r: Role | null) => r === "owner" || r === "operator" || r === "noc",
  // Video roles only; noc never watches (PRD section 2). Per-camera grants narrow this further (lib/access.ts).
  snapshot: (r: Role | null) => r === "owner" || r === "operator",
  audit: (r: Role | null) => r === "owner" || r === "noc",
  manageGrants: (r: Role | null) => r === "owner" || r === "noc",
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Pemilik",
  noc: "NOC",
  operator: "Operator",
  viewer: "Penonton",
};
