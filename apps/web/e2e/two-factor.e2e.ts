import { expect, type Page, test } from "@playwright/test";
import {
  closeDb,
  loginUi,
  newTenant,
  noLeaks,
  signInAs,
  totpFromBase32,
  USER_PASSWORD,
  watch,
} from "./support";

test.afterAll(closeDb);

const secretOf = async (page: Page) =>
  (await page.getByText("Kunci manual").locator("..").locator(".mono").innerText()).replace(/\s/g, "");

/** Walks the real setup screen like a person with an authenticator app and returns what they would hold. */
async function enableThroughUi(page: Page) {
  await page.goto("/keamanan");
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
  await expect(page.getByText("Belum aktif")).toBeVisible();
  await page.getByLabel("Kata sandi akun, untuk memulai").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Mulai aktifkan" }).click();
  await expect(page.getByRole("img", { name: "Kode QR untuk aplikasi autentikator" })).toBeVisible();
  const secret = await secretOf(page);
  const backup = await page
    .getByRole("heading", { name: "Kode cadangan", exact: true })
    .locator("xpath=following-sibling::ul[1]/li")
    .allInnerTexts();
  expect(backup.length).toBeGreaterThanOrEqual(8);
  // confirmation is refused until the backup codes are marked as saved
  await expect(page.getByRole("button", { name: "Konfirmasi dan aktifkan" })).toBeDisabled();
  await page.getByLabel("Saya sudah menyimpan kode cadangan.").check();
  await page.getByLabel("Kode 6 angka").fill(totpFromBase32(secret));
  await page.getByRole("button", { name: "Konfirmasi dan aktifkan" }).click();
  await expect(page.getByText("Verifikasi dua langkah aktif.")).toBeVisible();
  return { secret, backup };
}

test("aktifkan 2FA lewat UI, login meminta kode, kode cadangan sekali pakai, rahasia tidak bocor", async ({
  page,
  context,
}) => {
  const t = await newTenant("tf-ui");
  await signInAs(context, t);
  const w = watch(page, [401]);
  const { secret, backup } = await enableThroughUi(page);

  // the secret and codes are gone from the page once setup is finished
  await expect(page.getByRole("img", { name: "Kode QR untuk aplikasi autentikator" })).toHaveCount(0);
  await noLeaks(page, w, [secret, ...backup]);

  await page.getByRole("button", { name: "Keluar" }).click();
  await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();

  // password alone does not log in: the second step appears
  await loginUi(page, t.email);
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
  await expect(page.getByLabel("Kata sandi")).toHaveCount(0);
  await expect(page.getByLabel("Kode verifikasi")).toBeFocused();

  // a wrong code is refused with a message and no session
  const good = totpFromBase32(secret);
  await page.getByLabel("Kode verifikasi").fill(good === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Kode salah.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  // a malformed code is caught on the page, before any request
  await page.getByLabel("Kode verifikasi").fill("12ab");
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Kode harus 6 angka.")).toBeVisible();

  // the right code gets in
  await page.getByLabel("Kode verifikasi").fill(totpFromBase32(secret));
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page).toHaveURL(/\/perangkat/);
  await expect(page.getByRole("heading", { name: "Perangkat", exact: false }).first()).toBeVisible();
  await noLeaks(page, w, [secret, ...backup]);

  // sign out and back in with a backup code: works once
  await page.getByRole("button", { name: "Keluar" }).click();
  await loginUi(page, t.email);
  await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
  await page.getByLabel("Kode cadangan").fill(backup[0] as string);
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page).toHaveURL(/\/perangkat/);

  await page.getByRole("button", { name: "Keluar" }).click();
  await loginUi(page, t.email);
  await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
  await page.getByLabel("Kode cadangan").fill(backup[0] as string);
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Kode cadangan salah atau sudah dipakai.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
});

test("Kembali dari langkah kode memulai ulang dari kata sandi; tantangan tidak bisa dipakai tanpa masuk dulu", async ({
  page,
  context,
}) => {
  const t = await newTenant("tf-back");
  await signInAs(context, t);
  await enableThroughUi(page);
  await page.getByRole("button", { name: "Keluar" }).click();
  await loginUi(page, t.email);
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
  await page.getByRole("button", { name: "Kembali" }).click();
  await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
  await expect(page.getByLabel("Kata sandi")).toHaveValue("");
  // no session was created by the password step
  const res = await page.request.get("/v1/sites");
  expect(res.status()).toBe(401);
});

test("matikan 2FA butuh kata sandi, lalu login kembali tanpa kode", async ({ page, context }) => {
  const t = await newTenant("tf-off");
  await signInAs(context, t);
  const { secret } = await enableThroughUi(page);
  const off = page.getByLabel("Kata sandi akun, untuk mematikan");
  await off.fill("salah-salah-salah");
  await page.getByRole("button", { name: "Matikan", exact: true }).click();
  await expect(page.getByText("Kata sandi salah.")).toBeVisible();
  await expect(page.getByText("Aktif", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Kata sandi akun, untuk mematikan").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Matikan", exact: true }).click();
  await expect(page.getByText("Verifikasi dua langkah dimatikan.")).toBeVisible();
  await page.getByRole("button", { name: "Keluar" }).click();
  await loginUi(page, t.email);
  await expect(page).toHaveURL(/\/perangkat/);
  expect(secret.length).toBeGreaterThan(8);
});

test("buat ulang kode cadangan membatalkan kode lama", async ({ page, context }) => {
  const t = await newTenant("tf-regen");
  await signInAs(context, t);
  const { backup } = await enableThroughUi(page);
  await page.getByLabel("Kata sandi akun, untuk membuat ulang").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Buat ulang kode" }).click();
  await expect(page.getByRole("heading", { name: "Kode cadangan", exact: true })).toBeVisible();
  const fresh = await page
    .getByRole("heading", { name: "Kode cadangan", exact: true })
    .locator("xpath=following-sibling::ul[1]/li")
    .allInnerTexts();
  expect(fresh.length).toBeGreaterThanOrEqual(8);
  expect(fresh).not.toContain(backup[0]);
  await page.getByRole("button", { name: "Keluar" }).click();
  await loginUi(page, t.email);
  await page.getByRole("button", { name: "Pakai kode cadangan" }).click();
  await page.getByLabel("Kode cadangan").fill(backup[0] as string);
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page.getByText("Kode cadangan salah atau sudah dipakai.")).toBeVisible();
  await page.getByLabel("Kode cadangan").fill(fresh[0] as string);
  await page.getByRole("button", { name: "Verifikasi", exact: true }).click();
  await expect(page).toHaveURL(/\/perangkat/);
});
