"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, getJson, postVoid } from "@/lib/api";
import { type Role, toRole } from "@/lib/roles";
import { StateBlock } from "./ui";

const SessionSchema = z
  .object({
    session: z.object({ activeOrganizationId: z.string().nullish() }).passthrough(),
    user: z.object({ id: z.string(), name: z.string(), email: z.string() }).passthrough(),
  })
  .nullable();
const OrgsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), slug: z.string().nullish() }).passthrough(),
);
const RoleSchema = z.object({ role: z.string() }).passthrough();

export interface Org {
  id: string;
  name: string;
}
export interface SessionValue {
  user: { id: string; name: string; email: string };
  org: Org;
  orgs: Org[];
  role: Role | null;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionGate");
  return v;
};

/** Loads the session once, sends visitors without a session or organization to the right screen. */
export function SessionGate({ children, needOrg = true }: { children: ReactNode; needOrg?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [value, setValue] = useState<SessionValue | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const signOut = useCallback(async () => {
    try {
      await postVoid("/api/auth/sign-out", {});
    } finally {
      router.replace("/login");
    }
  }, [router]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getJson("/api/auth/get-session", SessionSchema);
        if (!s) return router.replace(`/login?next=${encodeURIComponent(path)}`);
        const orgs = (await getJson("/api/auth/organization/list", OrgsSchema)).map((o) => ({
          id: o.id,
          name: o.name,
        }));
        const activeId = s.session.activeOrganizationId ?? null;
        let org = orgs.find((o) => o.id === activeId);
        // A fresh login has no active organization; with exactly one there is nothing to choose.
        if (!org && needOrg && orgs.length === 1 && orgs[0]) {
          await postVoid("/api/auth/organization/set-active", { organizationId: orgs[0].id });
          org = orgs[0];
        }
        if (!org) {
          if (needOrg) return router.replace("/organisasi");
          if (alive) setValue({ user: s.user, org: { id: "", name: "" }, orgs, role: null, signOut });
          return;
        }
        const r = await getJson("/api/auth/organization/get-active-member-role", RoleSchema);
        if (alive) setValue({ user: s.user, org, orgs, role: toRole(r.role), signOut });
      } catch (e) {
        if (alive) setFailure(e instanceof ApiError ? e : new ApiError(0, "network_error"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [router, path, needOrg, signOut]);

  if (failure)
    return (
      <div className="mx-auto max-w-xl p-4">
        <StateBlock
          kind="error"
          title="Sesi tidak dapat dimuat."
          hint="Periksa koneksi ke server, lalu muat ulang halaman."
          action={
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Muat ulang
            </button>
          }
        />
      </div>
    );
  if (!value)
    return (
      <div className="mx-auto max-w-xl p-4">
        <StateBlock kind="loading" title="Memeriksa sesi…" />
      </div>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
