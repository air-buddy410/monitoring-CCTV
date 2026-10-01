"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { AppFrame } from "@/components/shell";
import { useSession } from "@/components/session";
import { StateBlock } from "@/components/ui";
import { postJson, postVoid } from "@/lib/api";
import { describeError } from "@/lib/errors";

const OrgCreated = z.object({ id: z.string() }).passthrough();

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

function OrgPicker() {
  const router = useRouter();
  const { orgs, org, signOut } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);

  const choose = async (organizationId: string) => {
    setBusy(true);
    setError(null);
    try {
      await postVoid("/api/auth/organization/set-active", { organizationId });
      router.push("/perangkat");
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const base = slugify(name);
    if (!base) {
      setError({ title: "Isi nama organisasi.", hint: "Gunakan huruf atau angka." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      const created = await postJson("/api/auth/organization/create", { name: name.trim(), slug }, OrgCreated);
      await choose(created.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-8 min-[900px]:grid-cols-2">
      <section aria-labelledby="pilih">
        <h1 id="pilih" className="h-page">
          Pilih organisasi
        </h1>
        <p className="mt-1 text-muted">Data perangkat dipisahkan per organisasi. Anda hanya melihat data organisasi yang aktif.</p>
        {error ? (
          <div className="mt-4">
            <StateBlock kind="error" title={error.title} hint={error.hint} />
          </div>
        ) : null}
        {orgs.length === 0 ? (
          <div className="mt-4">
            <StateBlock
              kind="empty"
              title="Anda belum tergabung di organisasi mana pun."
              hint="Buat organisasi baru di sebelah, atau minta pemilik organisasi menambahkan Anda. Undangan belum tersedia di antarmuka web ini."
            />
          </div>
        ) : (
          <ul className="mt-4 space-y-2">
            {orgs.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 border border-hair bg-panel p-3">
                <span>
                  <strong>{o.name}</strong>
                  {o.id === org.id ? <span className="ml-2 text-accent-ink">(aktif)</span> : null}
                </span>
                <button type="button" className="btn" disabled={busy} onClick={() => void choose(o.id)}>
                  Gunakan {o.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="buat">
        <h2 id="buat" className="h-section">
          Buat organisasi baru
        </h2>
        <p className="mt-1 text-muted">Pembuatnya otomatis menjadi pemilik.</p>
        <form onSubmit={create} className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="nama-org">
              Nama organisasi
            </label>
            <input id="nama-org" className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Buat organisasi
          </button>
        </form>
        <button type="button" className="btn btn-quiet mt-8" onClick={() => void signOut()}>
          Keluar
        </button>
      </section>
    </div>
  );
}

export default function OrganisasiPage() {
  return (
    <AppFrame needOrg={false}>
      <OrgPicker />
    </AppFrame>
  );
}
