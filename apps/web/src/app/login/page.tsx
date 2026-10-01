"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { StateBlock } from "@/components/ui";
import { postJson } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { safeNext } from "@/lib/format";
import { normalizeBackup, normalizeTotp } from "@/lib/totp";

const demo = process.env.NEXT_PUBLIC_DEMO === "1";
const AnyJson = z.unknown();
const SignInResult = z.object({ twoFactorRedirect: z.boolean().optional() }).passthrough();
const DEMO_EMAIL = "demo@pantau.test";
const DEMO_PASSWORD = "Dummy-Demo-Pass-123";

function LoginForm() {
  const router = useRouter();
  // Read from the address bar after mount so the form itself is rendered by the server (no blank page before hydration).
  const [expired, setExpired] = useState(false);
  useEffect(() => setExpired(new URLSearchParams(window.location.search).get("expired") === "1"), []);
  const [mode, setMode] = useState<"masuk" | "daftar">("masuk");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  // Second step after the password: set when the server answers with twoFactorRedirect.
  const [challenge, setChallenge] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  // Move focus to the code field when the step opens or the method changes, so a keyboard user can type at once.
  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge, useBackup]);

  const finish = () => router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = useBackup ? normalizeBackup(code) : normalizeTotp(code);
    if (!value) {
      setError(
        useBackup
          ? { title: "Kode cadangan belum lengkap.", hint: "Salin kode cadangan persis seperti saat dibuat." }
          : { title: "Kode harus 6 angka.", hint: "Buka aplikasi autentikator dan baca kode yang tampil." },
      );
      return;
    }
    setBusy(true);
    try {
      await postJson(
        useBackup ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp",
        { code: value },
        AnyJson,
      );
      finish();
    } catch (err) {
      setError(describeError(err));
      setCode("");
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "daftar" && password.length < 12) {
      setError({ title: "Kata sandi terlalu pendek.", hint: "Minimal 12 karakter." });
      return;
    }
    setBusy(true);
    try {
      if (mode === "masuk") {
        const r = await postJson("/api/auth/sign-in/email", { email, password }, SignInResult);
        if (r.twoFactorRedirect) {
          setPassword("");
          setChallenge(true);
          setBusy(false);
          return;
        }
      } else
        await postJson("/api/auth/sign-up/email", { email, password, name: name.trim() || email }, AnyJson);
      finish();
    } catch (err) {
      setError(describeError(err));
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh min-[900px]:grid-cols-[1.1fr_1fr]">
      <section
        aria-label="Tentang PANTAU"
        className="hidden border-r border-hair bg-panel p-10 min-[900px]:flex min-[900px]:flex-col min-[900px]:justify-between"
      >
        <p className="text-3xl font-extrabold tracking-[0.08em]">PANTAU</p>
        <div className="crop mx-3 my-10 bg-raised p-6" data-active="true">
          <p className="mono text-muted">Lembar probe</p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
            {["Merek", "Model", "Firmware", "Kanal", "Kemampuan"].map((k) => (
              <div key={k} className="contents">
                <dt className="font-bold">{k}</dt>
                <dd className="border-b border-hair" aria-hidden="true" />
              </div>
            ))}
          </dl>
          <p className="mono mt-4 text-muted">Diisi dari perangkat saat probe. Tidak ada angka contoh.</p>
        </div>
        <p className="max-w-md text-muted">
          PANTAU membaca merek, model, firmware, dan kemampuan perangkat lewat ONVIF, lalu mengambil snapshot
          dari kameranya.
        </p>
      </section>
      <section className="flex flex-col justify-center p-4 min-[900px]:p-10">
        <p className="mb-6 text-2xl font-extrabold tracking-[0.08em] min-[900px]:hidden">PANTAU</p>
        {challenge ? (
          <form onSubmit={submitCode} className="mx-auto w-full max-w-md" noValidate>
            <h1 className="h-page">Verifikasi dua langkah</h1>
            <p className="mt-1 text-muted">
              {useBackup
                ? "Masukkan satu kode cadangan. Setiap kode hanya berlaku sekali."
                : "Masukkan 6 angka dari aplikasi autentikator Anda."}
            </p>
            {error ? (
              <div className="mt-4">
                <StateBlock kind="error" title={error.title} hint={error.hint} />
              </div>
            ) : null}
            <div className="mt-4">
              <label className="label" htmlFor="kode">
                {useBackup ? "Kode cadangan" : "Kode verifikasi"}
              </label>
              <input
                id="kode"
                className="field mono"
                autoComplete="one-time-code"
                inputMode={useBackup ? "text" : "numeric"}
                spellCheck={false}
                autoCapitalize="none"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                ref={codeRef}
              />
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Memeriksa…" : "Verifikasi"}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setUseBackup(!useBackup);
                  setCode("");
                  setError(null);
                }}
              >
                {useBackup ? "Pakai kode autentikator" : "Pakai kode cadangan"}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setChallenge(false);
                  setUseBackup(false);
                  setCode("");
                  setError(null);
                }}
              >
                Kembali
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="mx-auto w-full max-w-md" noValidate>
            <h1 className="h-page">{mode === "masuk" ? "Masuk" : "Buat akun"}</h1>
            {expired ? (
              <div className="mt-4">
                <StateBlock
                  kind="expired"
                  title="Sesi Anda berakhir."
                  hint="Masuk lagi untuk melanjutkan di halaman tadi."
                />
              </div>
            ) : null}
            {error ? (
              <div className="mt-4">
                <StateBlock kind="error" title={error.title} hint={error.hint} />
              </div>
            ) : null}
            <div className="mt-4 space-y-4">
              {mode === "daftar" ? (
                <div>
                  <label className="label" htmlFor="nama">
                    Nama
                  </label>
                  <input
                    id="nama"
                    className="field"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              ) : null}
              <div>
                <label className="label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  className="field"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="sandi">
                  Kata sandi
                </label>
                <input
                  id="sandi"
                  type="password"
                  required
                  className="field"
                  autoComplete={mode === "masuk" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={mode === "daftar" ? "sandi-bantuan" : undefined}
                />
                {mode === "daftar" ? (
                  <p id="sandi-bantuan" className="help">
                    Minimal 12 karakter.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Memproses…" : mode === "masuk" ? "Masuk" : "Buat akun dan masuk"}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setMode(mode === "masuk" ? "daftar" : "masuk");
                  setError(null);
                }}
              >
                {mode === "masuk" ? "Belum punya akun? Daftar" : "Sudah punya akun? Masuk"}
              </button>
            </div>
            {demo ? (
              <div className="mt-8 border border-hair bg-panel p-3" role="note">
                <p className="font-bold">Akun simulasi (dummy, hanya untuk lab)</p>
                <p className="mono mt-1">
                  {DEMO_EMAIL}
                  <br />
                  {DEMO_PASSWORD}
                </p>
                <button
                  type="button"
                  className="btn mt-2"
                  onClick={() => {
                    setMode("masuk");
                    setEmail(DEMO_EMAIL);
                    setPassword(DEMO_PASSWORD);
                  }}
                >
                  Isi akun simulasi
                </button>
              </div>
            ) : null}
          </form>
        )}
      </section>
    </div>
  );
}

export default function LoginPage() {
  return <LoginForm />;
}
