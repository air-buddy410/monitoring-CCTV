import { expect, test } from "@playwright/test";
import {
  API,
  closeDb,
  DEVICE_PASSWORD,
  DEVICE_USER,
  newTenant,
  noLeaks,
  seedDevice,
  signInAs,
  startMock,
  USER_PASSWORD,
  watch,
} from "./support";

test.afterAll(closeDb);

test("alur utama: daftar, organisasi, tambah perangkat, probe, kamera, snapshot, refresh, audit, keluar", async ({
  page,
  context,
}) => {
  const mock = await startMock();
  const w = watch(page);
  const email = `alur-${Date.now()}@example.test`;

  // Normal mode shows no simulation banner and no simulation presets.
  await page.goto("/login");
  await expect(page.getByText("Mode Simulasi")).toHaveCount(0);
  await page.getByRole("button", { name: "Belum punya akun? Daftar" }).click();
  await page.getByLabel("Nama").fill("Operator Uji");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Buat akun dan masuk" }).click();

  // Tenant selection: a new user has no organization yet.
  await expect(page).toHaveURL(/\/organisasi$/);
  await expect(page.getByText("Anda belum tergabung di organisasi mana pun.")).toBeVisible();
  await page.getByLabel("Nama organisasi").fill("Gudang Uji");
  await page.getByRole("button", { name: "Buat organisasi" }).click();
  await expect(page).toHaveURL(/\/perangkat$/);
  await expect(page.getByText("Belum ada perangkat di organisasi ini.")).toBeVisible();
  await expect(page.getByText("Pemilik", { exact: false }).first()).toBeVisible();

  // Add a device through the real form against the mock ONVIF device.
  await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Tambah perangkat" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Simulasi")).toHaveCount(0);
  await dialog.getByLabel("Nama lokasi baru").fill("Gudang Utama");
  await dialog.getByLabel("Nama perangkat").fill("NVR Gudang");
  await dialog.getByLabel("Alamat IP").fill(mock.host);
  await dialog.getByLabel("Port").fill(String(mock.port));
  await dialog.getByLabel("Nama pengguna perangkat").fill(DEVICE_USER);
  await dialog.getByLabel("Kata sandi perangkat").fill(DEVICE_PASSWORD);
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();

  // Probe results come from the device through the real backend.
  await expect(page).toHaveURL(/\/perangkat\?d=dev_/);
  await expect(dialog).toBeHidden();
  const sheet = page.getByRole("region", { name: "Lembar probe" });
  await expect(sheet.getByText("mockvendor")).toBeVisible();
  await expect(sheet.getByText("MV-NVR-2")).toBeVisible();
  await expect(sheet.getByText("9.9.9-mock")).toBeVisible();
  await expect(sheet.getByText("NVR (lebih dari satu kanal)")).toBeVisible();
  await expect(sheet.getByText("Bukan status perangkat sekarang", { exact: false })).toBeVisible();
  await expect(page.getByText("online", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Kamera (2)" })).toBeVisible();

  // Snapshot, then refresh: each press must really reach the mock camera.
  await expect(page.getByText("Belum ada snapshot untuk kamera ini.")).toBeVisible();
  expect(mock.snapshotRequestCount()).toBe(0);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  const img = page.locator("img[alt^='Snapshot kamera']");
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([1280, 720]);
  expect(mock.snapshotRequestCount()).toBe(1);
  await expect(page.getByText(/Diterima di browser \d/)).toBeVisible();
  await page.getByRole("button", { name: "Ambil snapshot lagi" }).click();
  await expect.poll(() => mock.snapshotRequestCount()).toBe(2);
  await expect(img).toBeVisible();

  // Second camera.
  await page.getByRole("link", { name: /VSC1/ }).click();
  await expect(page.getByRole("heading", { name: "Snapshot: VSC1" })).toBeVisible();
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(img).toBeVisible();
  expect(mock.snapshotRequestCount()).toBe(3);

  // Download link and full screen with focus return.
  const download = page.getByRole("link", { name: "Unduh JPEG" });
  await expect(download).toHaveAttribute("download", /\.jpg$/);
  await expect(download).toHaveAttribute("href", /^blob:/);
  const full = page.getByRole("button", { name: "Layar penuh" });
  await full.click();
  const viewer = page.getByRole("dialog", { name: "Snapshot VSC1" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(full).toBeFocused();

  // Search and filters on real fields, including the empty result.
  await page.getByLabel("Cari perangkat").fill("zzz-tidak-ada");
  await expect(page.getByText("Tidak ada perangkat yang cocok dengan saringan ini.")).toBeVisible();
  await page.getByRole("button", { name: "Hapus saringan" }).click();
  await expect(page.getByRole("link", { name: /NVR Gudang/ })).toBeVisible();
  await page.getByLabel("Cari perangkat").fill("mockvendor mv-nvr");
  await expect(page.getByRole("link", { name: /NVR Gudang/ })).toBeVisible();
  await page.getByLabel("Cari perangkat").fill("");
  await page.getByLabel("Kemampuan").selectOption("ptz");
  await expect(page.getByText("1 dari 1 perangkat cocok.")).toBeVisible();

  // Audit (owner only) lists the two kinds of events.
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await expect(page.getByText("Perangkat ditambahkan").first()).toBeVisible();
  await expect(page.getByText("Snapshot diambil").first()).toBeVisible();

  // No secrets anywhere the browser can see, session cookie not readable by scripts.
  await noLeaks(page, w, [DEVICE_PASSWORD, USER_PASSWORD]);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "better-auth.session_token");
  expect(session?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");

  // Logout ends the session for real.
  await page.getByRole("button", { name: "Keluar" }).click();
  await expect(page).toHaveURL(/\/login/);
  const after = await page.request.get("/v1/devices");
  expect(after.status()).toBe(401);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("papan ketik: dialog menjebak fokus, Escape menutup, fokus kembali ke pemicu", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("kbd");
  await seedDevice(t, mock);
  await signInAs(context, t);
  const w = watch(page);
  await page.goto("/perangkat");
  const trigger = page.getByRole("button", { name: "Tambah perangkat" }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Tambah perangkat" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog")), `Tab ${i}`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog")), `Shift+Tab ${i}`).toBe(
      true,
    );
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(w.consoleErrors).toEqual([]);
  await mock.stop();
});

test("papan ketik: layar masuk bisa dipakai tanpa mouse dan fokus selalu terlihat", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(
        () =>
          (document.activeElement as HTMLElement)?.id || document.activeElement?.textContent?.trim() || "",
      ),
    );
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    );
    expect(outline, `focus indicator on ${order[i]}`).not.toBe("none");
  }
  expect(order.slice(0, 3)).toEqual(["email", "sandi", "Masuk"]);
  expect(API).toContain("3101");
});
