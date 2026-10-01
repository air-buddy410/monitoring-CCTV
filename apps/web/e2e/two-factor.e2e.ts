import { expect, test } from "@playwright/test";
import { closeDb, enableTwoFactor, newTenant, totp, USER_PASSWORD, watch } from "./support";

test.afterAll(closeDb);

test("login dengan 2FA: kata sandi saja tidak cukup, kode TOTP menyelesaikan masuk", async ({ page }) => {
  const user = await newTenant("tfa");
  const secret = await enableTwoFactor(user);
  const w = watch(page);

  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Kata sandi").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();

  // The password is accepted, but a second step is required before any workspace appears.
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
  await expect(page.getByLabel("Kode verifikasi")).toBeVisible();

  await page.getByLabel("Kode verifikasi").fill(totp(secret));
  await page.getByRole("button", { name: "Verifikasi" }).click();

  // Only now does the authenticated shell show up.
  await expect(page.getByRole("link", { name: "PANTAU" })).toBeVisible();
  await expect(page).toHaveURL(/\/perangkat/);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
});

test("kode TOTP salah ditolak dan tetap di layar verifikasi", async ({ page }) => {
  const user = await newTenant("tfa-bad");
  await enableTwoFactor(user);
  const w = watch(page, [401, 400]);

  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Kata sandi").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();

  await page.getByLabel("Kode verifikasi").fill("000000");
  await page.getByRole("button", { name: "Verifikasi" }).click();

  // Still on the challenge; no session, no workspace.
  await expect(page.getByRole("heading", { name: "Verifikasi dua langkah" })).toBeVisible();
  await expect(page.getByRole("link", { name: "PANTAU" })).toHaveCount(0);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
});
