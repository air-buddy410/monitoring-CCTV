"use client";

import { type FormEvent, useState } from "react";
import { z } from "zod";
import { QrCode } from "@/components/qr";
import { useSession } from "@/components/session";
import { AppFrame } from "@/components/shell";
import { StateBlock } from "@/components/ui";
import { postJson } from "@/lib/api";
import { describeError, type Message } from "@/lib/errors";
import { groupSecret, normalizeTotp, secretFromUri } from "@/lib/totp";

const Enabled = z.object({ totpURI: z.string(), backupCodes: z.array(z.string()) }).passthrough();
const Regenerated = z.object({ backupCodes: z.array(z.string()) }).passthrough();
const Anything = z.unknown();

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div>
      <h3 className="font-bold">Kode cadangan</h3>
      <p className="help">
        Setiap kode berlaku sekali dan menggantikan aplikasi autentikator bila ponsel hilang. Simpan di tempat
        aman. Kode ini tidak ditampilkan lagi setelah Anda meninggalkan layar ini.
      </p>
      <ul className="mono mt-2 grid max-w-md grid-cols-2 gap-x-6 gap-y-1">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

function PasswordForm({
  label,
  action,
  busy,
  onSubmit,
  danger,
}: {
  label: string;
  action: string;
  busy: boolean;
  onSubmit: (password: string) => void;
  danger?: boolean;
}) {
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = password;
    setPassword("");
    onSubmit(p);
  };
  return (
    <form onSubmit={submit} className="mt-3 max-w-sm space-y-3">
      <div>
        <label className="label" htmlFor={`pw-${action}`}>
          {label}
        </label>
        <input
          id={`pw-${action}`}
          type="password"
          required
          className="field"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button type="submit" className={danger ? "btn" : "btn btn-primary"} disabled={busy || !password}>
        {busy ? "Memproses…" : action}
      </button>
    </form>
  );
}

function TwoFactorPanel() {
  const { user } = useSession();
  const [enabled, setEnabled] = useState(user.twoFactorEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // These live in memory only: never in storage, the URL, or logs.
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const begin = (password: string) =>
    run(async () => {
      const r = await postJson("/api/auth/two-factor/enable", { password }, Enabled);
      setSetup({ uri: r.totpURI, codes: r.backupCodes });
      setSaved(false);
      setCode("");
    });

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    const value = normalizeTotp(code);
    if (!value) {
      setError({
        title: "Kode harus 6 angka.",
        hint: "Baca kode yang sedang tampil di aplikasi autentikator.",
      });
      return;
    }
    void run(async () => {
      await postJson("/api/auth/two-factor/verify-totp", { code: value }, Anything);
      setSetup(null);
      setCode("");
      setEnabled(true);
      setNotice(
        "Verifikasi dua langkah aktif. Mulai sekarang login meminta kode dari aplikasi autentikator.",
      );
    });
  };

  const disable = (password: string) =>
    run(async () => {
      await postJson("/api/auth/two-factor/disable", { password }, Anything);
      setEnabled(false);
      setFresh(null);
      setNotice("Verifikasi dua langkah dimatikan.");
    });

  const regenerate = (password: string) =>
    run(async () => {
      const r = await postJson("/api/auth/two-factor/generate-backup-codes", { password }, Regenerated);
      setFresh(r.backupCodes);
    });

  const secret = setup ? secretFromUri(setup.uri) : null;

  return (
    <section aria-labelledby="dua-langkah" className="max-w-2xl">
      <h2 id="dua-langkah" className="h-section">
        Verifikasi dua langkah
      </h2>
      <p className="mt-1 text-muted">
        Status: <strong className="text-ink">{enabled ? "Aktif" : "Belum aktif"}</strong>. Kode 6 angka dari
        aplikasi autentikator (TOTP) diminta setelah kata sandi. Untuk melihat video, verifikasi ini wajib di
        lingkungan produksi.
      </p>
      {error ? (
        <div className="mt-4">
          <StateBlock kind="error" title={error.title} hint={error.hint} />
        </div>
      ) : null}
      {notice ? (
        <div className="mt-4">
          <StateBlock kind="empty" title={notice} />
        </div>
      ) : null}

      {!enabled && !setup ? (
        <PasswordForm
          label="Kata sandi akun, untuk memulai"
          action="Mulai aktifkan"
          busy={busy}
          onSubmit={(p) => void begin(p)}
        />
      ) : null}

      {setup ? (
        <form onSubmit={confirm} className="mt-4 space-y-5" noValidate>
          <div>
            <h3 className="font-bold">1. Tambahkan ke aplikasi autentikator</h3>
            <p className="help">Pindai kode QR, atau ketik kunci ini secara manual.</p>
            <div className="mt-3 flex flex-wrap items-start gap-6">
              <div className="crop mx-2 my-2 inline-block">
                <QrCode text={setup.uri} label="Kode QR untuk aplikasi autentikator" />
              </div>
              {secret ? (
                <div>
                  <p className="label">Kunci manual</p>
                  <p className="mono break-all text-lg">{groupSecret(secret)}</p>
                </div>
              ) : null}
            </div>
          </div>
          <BackupCodes codes={setup.codes} />
          <div>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
                className="size-5"
              />
              <span>Saya sudah menyimpan kode cadangan.</span>
            </label>
          </div>
          <div className="max-w-xs">
            <h3 className="font-bold">2. Masukkan kode untuk memastikan</h3>
            <label className="label mt-2" htmlFor="kode-konfirmasi">
              Kode 6 angka
            </label>
            <input
              id="kode-konfirmasi"
              className="field mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || !saved}>
              {busy ? "Memeriksa…" : "Konfirmasi dan aktifkan"}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setSetup(null);
                setCode("");
                setError(null);
              }}
            >
              Batalkan
            </button>
          </div>
          {!saved ? <p className="help">Tombol aktif setelah kode cadangan ditandai tersimpan.</p> : null}
        </form>
      ) : null}

      {enabled ? (
        <div className="mt-4 space-y-8">
          <div>
            <h3 className="font-bold">Buat ulang kode cadangan</h3>
            <p className="help">Kode lama tidak berlaku lagi.</p>
            <PasswordForm
              label="Kata sandi akun, untuk membuat ulang"
              action="Buat ulang kode"
              busy={busy}
              onSubmit={(p) => void regenerate(p)}
            />
            {fresh ? (
              <div className="mt-4">
                <BackupCodes codes={fresh} />
              </div>
            ) : null}
          </div>
          <div>
            <h3 className="font-bold">Matikan verifikasi dua langkah</h3>
            <p className="help">Login kembali hanya dengan email dan kata sandi.</p>
            <PasswordForm
              label="Kata sandi akun, untuk mematikan"
              action="Matikan"
              busy={busy}
              onSubmit={(p) => void disable(p)}
              danger
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function KeamananPage() {
  return (
    <AppFrame needOrg={false}>
      <div className="mx-auto max-w-5xl">
        <h1 className="h-page">Keamanan akun</h1>
        <div className="mt-6">
          <TwoFactorPanel />
        </div>
      </div>
    </AppFrame>
  );
}
