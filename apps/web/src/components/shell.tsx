"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { can, ROLE_LABEL } from "@/lib/roles";
import { SessionGate, useSession } from "./session";
import { ThemeToggle } from "./theme-toggle";
import { Dialog } from "./ui";

function NavItems({ stacked, onNavigate }: { stacked?: boolean; onNavigate?: () => void }) {
  const { role, org, signOut } = useSession();
  const path = usePathname();
  const link = (href: string, label: string) => (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={path === href ? "page" : undefined}
      className={`btn btn-quiet ${path === href ? "underline decoration-2 underline-offset-8" : ""}`}
    >
      {label}
    </Link>
  );
  return (
    <div className={stacked ? "flex flex-col items-stretch gap-1 p-3" : "flex items-center gap-1"}>
      {link("/perangkat", "Perangkat")}
      {link("/akses", "Akses")}
      {can.audit(role) ? link("/audit", "Audit") : null}
      {link("/keamanan", "Keamanan")}
      {org.name ? (
        <div className={stacked ? "px-3 py-2" : "mx-2 hidden min-[1000px]:block"}>
          <span className="text-muted">Organisasi </span>
          <strong>{org.name}</strong>
          {role ? <span className="text-muted"> ({ROLE_LABEL[role]})</span> : null}
        </div>
      ) : null}
      {link("/organisasi", "Ganti organisasi")}
      <ThemeToggle />
      <button type="button" className="btn" onClick={() => void signOut()}>
        Keluar
      </button>
    </div>
  );
}

function TopBar() {
  const [menu, setMenu] = useState(false);
  return (
    <header className="border-b border-hair bg-panel">
      <div className="mx-auto flex min-h-14 max-w-[1680px] items-center justify-between gap-2 px-3 min-[720px]:px-5">
        <Link href="/perangkat" className="btn btn-quiet text-lg font-extrabold tracking-[0.08em]">
          PANTAU
        </Link>
        <nav aria-label="Utama" className="hidden min-[720px]:block">
          <NavItems />
        </nav>
        <button type="button" className="btn min-[720px]:hidden" onClick={() => setMenu(true)}>
          Menu
        </button>
      </div>
      <Dialog open={menu} onClose={() => setMenu(false)} title="Menu">
        <nav aria-label="Utama (ponsel)">
          <NavItems stacked onNavigate={() => setMenu(false)} />
        </nav>
      </Dialog>
    </header>
  );
}

/** Authenticated page frame: session gate, top bar, content. */
export function AppFrame({ children, needOrg = true }: { children: ReactNode; needOrg?: boolean }) {
  return (
    <SessionGate needOrg={needOrg}>
      <TopBar />
      <main className="mx-auto max-w-[1680px] px-3 py-4 min-[720px]:px-5">{children}</main>
    </SessionGate>
  );
}
