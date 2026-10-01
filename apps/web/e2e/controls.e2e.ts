import { expect, test } from "@playwright/test";
import { addOrg, closeDb, newTenant, noLeaks, seedDevice, signInAs, startMock, watch } from "./support";

test.afterAll(closeDb);

test("ponsel 390px: Menu, navigasi, pindah organisasi, saring, kembali ke daftar, tema, keluar", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "id-ID",
    colorScheme: "light",
  });
  const page = await context.newPage();
  const w = watch(page);
  const mockA = await startMock({ channels: 1, model: "MV-A" });
  const mockB = await startMock({ channels: 1, model: "MV-B" });
  const t = await newTenant("ctl");
  const a = await seedDevice(t, mockA, "Kamera Gerbang");
  await seedDevice(t, mockB, "Kamera Dapur");
  const otherName = "Organisasi Kedua";
  const otherId = await addOrg(t, otherName);
  expect(otherId).toBeTruthy();
  await signInAs(context, t);

  // The user now belongs to two organizations; the session's active one is the second (empty) one.
  await page.goto("/perangkat");
  await expect(page.getByText("Belum ada perangkat di organisasi ini.")).toBeVisible();

  // Menu: opens a dialog, Escape closes it and focus returns to the Menu button.
  const menuButton = page.getByRole("button", { name: "Menu" });
  await menuButton.click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();

  // Menu -> Ganti organisasi -> choose the first organization: data changes with the tenant.
  await menuButton.click();
  await menu.getByRole("link", { name: "Ganti organisasi" }).click();
  await expect(page).toHaveURL(/\/organisasi$/);
  await expect(menu).toBeHidden();
  await expect(page.getByRole("heading", { name: "Pilih organisasi" })).toBeVisible();
  await page.getByRole("button", { name: /^Gunakan Organisasi ctl/ }).click();
  await expect(page).toHaveURL(/\/perangkat$/);
  await expect(page.getByRole("link", { name: /Kamera Gerbang/ })).toBeVisible();
  await expect(page.getByText("2 perangkat.")).toBeVisible();

  // Filter sheet: choose, apply, clear, close with the X button.
  await page.getByLabel("Cari perangkat").fill("dapur");
  await expect(page.getByText("1 dari 2 perangkat cocok.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Kamera Gerbang/ })).toHaveCount(0);
  await page.getByLabel("Cari perangkat").fill("");
  await page.getByRole("button", { name: /^Saring/ }).click();
  const sheet = page.getByRole("dialog", { name: "Saring perangkat" });
  await sheet.getByLabel("Lokasi").selectOption({ index: 1 });
  await sheet.getByLabel("Lokasi").selectOption({ index: 0 });
  await sheet.getByLabel("Jenis").selectOption("nvr");
  await sheet.getByRole("button", { name: /^Lihat 0 perangkat/ }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("Tidak ada perangkat yang cocok dengan saringan ini.")).toBeVisible();
  await page.getByRole("button", { name: /^Saring/ }).click();
  await sheet.getByRole("button", { name: "Hapus saringan" }).click();
  await sheet.getByRole("button", { name: "Tutup", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("2 perangkat.")).toBeVisible();

  // Device screen with the back button; keyboard activation of the snapshot action.
  await page.getByRole("link", { name: /Kamera Gerbang/ }).click();
  await expect(page).toHaveURL(/\?d=dev_/);
  await expect(page.getByRole("link", { name: /Kamera Gerbang/ })).toHaveCount(0);
  const take = page.getByRole("button", { name: "Ambil snapshot", exact: true });
  await take.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
  await page.getByRole("button", { name: "Ambil snapshot lagi" }).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => mockA.snapshotRequestCount()).toBe(2);
  await page.getByRole("link", { name: "Kembali ke daftar" }).click();
  await expect(page).toHaveURL(/\/perangkat$/);
  await expect(page.getByRole("link", { name: /Kamera Gerbang/ })).toBeVisible();

  // Menu -> Audit, then theme toggle, then logout.
  await menuButton.click();
  await menu.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
  await page.getByLabel("Jumlah catatan terbaru").selectOption("100");
  await expect(page.getByText("Snapshot diambil").first()).toBeVisible();
  await menuButton.click();
  await menu.getByRole("button", { name: /Mode gelap/ }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await menu.getByRole("button", { name: "Keluar" }).click();
  await expect(page).toHaveURL(/\/login/);

  await noLeaks(page, w, ["Dummy-Sentinel-Pw-7391!"]);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mockA.stop();
  await mockB.stop();
  await context.close();
});

test("desktop: pilihan perangkat dan kamera punya penanda teks, tombol Tutup dialog, status memuat", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 2 });
  const t = await newTenant("dsk");
  const { device } = await seedDevice(t, mock, "Perangkat Pilihan");
  await signInAs(context, t);
  const w = watch(page);

  // Loading state is visible while the real list calls are still pending.
  await page.route("**/v1/devices", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.goto("/perangkat");
  await expect(page.getByText("Memuat perangkat, kamera, dan lokasi…")).toBeVisible();
  await expect(page.getByRole("link", { name: /Perangkat Pilihan/ })).toBeVisible();
  await page.unroute("**/v1/devices");

  await page.getByRole("link", { name: /Perangkat Pilihan/ }).click();
  await expect(page).toHaveURL(new RegExp(`d=${device.id}`));
  await expect(page.getByRole("link", { name: /Perangkat Pilihan \(dipilih\)/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /VSC0 \(dipilih\)/ })).toBeVisible();
  await page.getByRole("link", { name: /^VSC1/ }).click();
  await expect(page.getByRole("link", { name: /VSC1 \(dipilih\)/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /VSC0 \(dipilih\)/ })).toHaveCount(0);

  // X button closes a dialog, focus goes back to its trigger; the form keeps nothing afterwards.
  const add = page.getByRole("button", { name: "Tambah perangkat" }).first();
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Tambah perangkat" });
  await dialog.getByLabel("Kata sandi perangkat").fill("Dummy-Sentinel-Pw-7391!");
  await dialog.getByRole("button", { name: "Tutup", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await add.click();
  await expect(dialog.getByLabel("Kata sandi perangkat")).toHaveValue("");
  await page.keyboard.press("Escape");

  // Organization link in the top bar reaches the picker, which marks the active organization in text.
  await page.getByRole("link", { name: "Ganti organisasi" }).click();
  await expect(page.getByText("(aktif)")).toBeVisible();
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("kontrol yang tersisa: logo, layar penuh (tutup dan unduh nyata), keadaan kosong, halaman organisasi, pemulihan", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("rest");
  const empty = await newTenant("rest-kosong");
  const { device } = await seedDevice(t, mock);
  await signInAs(context, t);
  const w = watch(page, [500]);

  await page.goto(`/perangkat?d=${device.id}`);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();

  // Download really delivers a JPEG file.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Unduh JPEG" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.jpg$/);

  // Full screen closes with its own button, and focus returns.
  const full = page.getByRole("button", { name: "Layar penuh" });
  await full.click();
  const viewer = page.getByRole("dialog", { name: "Snapshot VSC0" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Tutup layar penuh" }).click();
  await expect(viewer).toBeHidden();
  await expect(full).toBeFocused();

  // The wordmark goes back to the device list.
  await page.getByRole("link", { name: "PANTAU" }).click();
  await expect(page).toHaveURL(/\/perangkat$/);

  // The organization page has its own logout button.
  await page.getByRole("link", { name: "Ganti organisasi" }).click();
  await expect(page.getByRole("heading", { name: "Pilih organisasi" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Keluar" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Sign-up and sign-in modes toggle back and forth.
  await page.getByRole("button", { name: "Belum punya akun? Daftar" }).click();
  await expect(page.getByRole("heading", { name: "Buat akun" })).toBeVisible();
  await page.getByRole("button", { name: "Sudah punya akun? Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();

  // Empty state offers its own Tambah perangkat button (the second one on the page).
  await context.clearCookies();
  await signInAs(context, empty);
  await page.goto("/perangkat");
  await page.getByRole("button", { name: "Tambah perangkat" }).last().click();
  await expect(page.getByRole("dialog", { name: "Tambah perangkat" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Session cannot be loaded: message with a working Muat ulang.
  await page.route("**/api/auth/get-session", (r) => r.abort());
  await page.goto("/perangkat");
  await expect(page.getByText("Sesi tidak dapat dimuat.")).toBeVisible();
  await page.unroute("**/api/auth/get-session");
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(page.getByText("Belum ada perangkat di organisasi ini.")).toBeVisible();

  // Audit load failure: message with a working Coba lagi.
  await page.route("**/v1/audit**", (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/problem+json",
      body: JSON.stringify({ type: "about:blank", title: "x", status: 500, code: "internal_error" }),
    }),
  );
  await page.goto("/audit");
  await expect(page.getByText("Server mengalami galat.")).toBeVisible();
  await page.unroute("**/v1/audit**");
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Belum ada catatan audit.")).toBeVisible();
  expect(
    w.consoleErrors.filter((e) => !/ERR_FAILED|Failed to load resource/.test(e)),
    w.consoleErrors.join("\n"),
  ).toEqual([]);
  await mock.stop();
});
