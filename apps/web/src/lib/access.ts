import type { Grant } from "@pantau/contracts";
import type { z } from "zod";
import type { Role } from "./roles";

export type GrantT = z.infer<typeof Grant>;
export type Level = "operate" | "view" | "none";
type Cam = { id: string; siteId: string };

const applies = (g: GrantT, cam: Cam) =>
  (g.scope === "camera" && g.scopeId === cam.id) || (g.scope === "site" && g.scopeId === cam.siteId);

/** Mirrors the server rule in apps/api/src/access.ts for display only; the server decides. */
export function effectiveAccess(role: Role | null, cam: Cam, grants: readonly GrantT[]): Level {
  if (role === "owner") return "operate";
  if (role !== "operator" && role !== "viewer") return "none";
  const mine = grants.filter((g) => applies(g, cam));
  if (mine.length === 0) return "none";
  // a viewer never operates, whatever the grant says
  if (role === "operator" && mine.some((g) => g.permission === "operate")) return "operate";
  return "view";
}

export type Access = { allowed: true } | { allowed: false; reason: "role" | "no_grant" | "view_only" };

export function snapshotAccess(role: Role | null, cam: Cam, myGrants: readonly GrantT[]): Access {
  if (role !== "owner" && role !== "operator") return { allowed: false, reason: "role" };
  const level = effectiveAccess(role, cam, myGrants);
  if (level === "operate") return { allowed: true };
  return { allowed: false, reason: level === "view" ? "view_only" : "no_grant" };
}

export const ACCESS_HINT: Record<"role" | "no_grant" | "view_only", string> = {
  role: "Peran Anda hanya dapat melihat data. Mengambil snapshot memerlukan peran operator.",
  no_grant: "Anda belum diberi akses ke kamera ini. Minta pemilik memberi akses operasi di halaman Akses.",
  view_only: "Akses Anda ke kamera ini hanya melihat. Mengambil snapshot memerlukan akses operasi.",
};

export const LEVEL_LABEL: Record<Level, string> = {
  operate: "Operasi",
  view: "Lihat",
  none: "Tidak ada akses",
};
