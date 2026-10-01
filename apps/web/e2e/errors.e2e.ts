import { expect, test } from "@playwright/test";
import {
  closeDb,
  DEVICE_PASSWORD,
  newTenant,
  noLeaks,
  seedDevice,
  signInAs,
  startMock,
  watch,
} from "./support";

test.afterAll(closeDb);

async function openAdd(page: import("@playwright/test").Page) {
  await page.goto("/perangkat");
  await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
  return page.getByRole("dialog", { name: "Tambah perangkat" });
}

async function fill(
  dialog: import("@playwright/test").Locator,
  v: { host: string; port: number | string; user?: string; password?: string; name?: string },
) {
  await dialog.getByLabel("Nama lokasi baru").fill("Lokasi Uji");
  await dialog.getByLabel("Nama perangkat").fill(v.name ?? "Perangkat Uji");
  await dialog.getByLabel("Alamat IP").fill(v.host);
  await dialog.getByLabel("Port").fill(String(v.port));
  await dialog.getByLabel("Nama pengguna perangkat").fill(v.user ?? "dummy-admin");
  await dialog.getByLabel("Kata sandi perangkat").fill(v.password ?? DEVICE_PASSWORD);
}

test("form tambah perangkat: validasi sisi klien dengan fokus ke kolom bermasalah", async ({
  page,
  context,
}) => {
  const t = await newTenant("val");
  await signInAs(context, t);
  const w = watch(page);
  const dialog = await openAdd(page);
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Isian belum lengkap.")).toBeVisible();
  await expect(dialog.getByText("Isi nama lokasi baru.")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("dev-newSiteName");
  await fill(dialog, { host: "kamera.example.test", port: "99999" });
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Harus berupa alamat IP", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Port 1 sampai 65535.")).toBeVisible();
  await expect(dialog.locator("[aria-invalid='true']")).toHaveCount(2);
  expect(w.consoleErrors).toEqual([]);
});

test("kesalahan nyata dari backend: kredensial salah, alamat di luar kebijakan, perangkat tidak menjawab", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const hung = await startMock({ hangOperations: ["GetDeviceInformation"] });
  const t = await newTenant("srv");
  await signInAs(context, t);
  const w = watch(page, [422, 504]);
  const dialog = await openAdd(page);

  await fill(dialog, { host: mock.host, port: mock.port, password: "Wrong-Dummy-Pw-0000!" });
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Perangkat menolak nama pengguna atau kata sandi.")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Wrong-Dummy-Pw-0000!");

  await dialog.getByLabel("Alamat IP").fill("8.8.8.8");
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Alamat ini tidak boleh dipakai sebagai target.")).toBeVisible();

  await dialog.getByLabel("Alamat IP").fill(hung.host);
  await dialog.getByLabel("Port").fill(String(hung.port));
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Perangkat tidak menjawab tepat waktu.")).toBeVisible({ timeout: 15_000 });

  await noLeaks(page, w, [DEVICE_PASSWORD, "Wrong-Dummy-Pw-0000!"]);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
  await hung.stop();
});

test("429 nyata pada probe: batas diterapkan server dan UI menjelaskannya", async ({ page, context }) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("rl");
  await signInAs(context, t);
  const w = watch(page, [422, 429]);
  const dialog = await openAdd(page);
  await fill(dialog, { host: mock.host, port: mock.port, password: "Wrong-Dummy-Pw-0000!" });
  for (let i = 0; i < 6; i++) {
    await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
    await expect(dialog.getByText("Perangkat menolak nama pengguna atau kata sandi.")).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(dialog.getByText("Terlalu banyak percobaan.")).toBeVisible();
  await expect(dialog.getByText(/Coba lagi dalam \d+ detik/)).toBeVisible();
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("429 nyata pada snapshot: tombol dikunci dengan hitung mundur, bukan gambar palsu", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("rls");
  const { device } = await seedDevice(t, mock);
  await signInAs(context, t);
  const w = watch(page, [429]);
  await page.goto(`/perangkat?d=${device.id}`);
  const take = page.getByRole("button", { name: /Ambil snapshot/ });
  for (let i = 0; i < 6; i++) {
    await take.click();
    await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
    await expect(take).toBeEnabled();
  }
  await take.click();
  await expect(page.getByText("Terlalu banyak percobaan.")).toBeVisible();
  await expect(page.locator("img[alt^='Snapshot kamera']")).toHaveCount(0);
  await expect(take).toBeDisabled();
  await expect(take).toContainText(/tunggu \d+ dtk/);
  expect(mock.snapshotRequestCount()).toBe(6);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("snapshot gagal tidak pernah tampil sebagai gambar, dan coba lagi berhasil setelah pulih", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("fail");
  const { device } = await seedDevice(t, mock);
  await signInAs(context, t);
  const w = watch(page, [502]);
  await page.goto(`/perangkat?d=${device.id}`);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  const img = page.locator("img[alt^='Snapshot kamera']");
  await expect(img).toBeVisible();

  mock.setSnapshotBody(Buffer.from("<html>bukan jpeg</html>"));
  await page.getByRole("button", { name: "Ambil snapshot lagi" }).click();
  await expect(page.getByText("Perangkat tidak mengirim gambar JPEG yang sah.")).toBeVisible();
  await expect(img).toHaveCount(0);
  await expect(page.getByText("Belum ada gambar")).toBeVisible();
  await expect(page.getByRole("link", { name: "Unduh JPEG" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Layar penuh" })).toBeDisabled();

  mock.setSnapshotBody(null);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(img).toBeVisible();
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("server tidak terjangkau: pesan jelas dan Coba lagi memulihkan (jaringan diputus di sisi browser)", async ({
  page,
  context,
}) => {
  const t = await newTenant("net");
  await signInAs(context, t);
  const w = watch(page);
  await page.route("**/v1/devices", (r) => r.abort());
  await page.goto("/perangkat");
  await expect(page.getByText("Server tidak dapat dihubungi.")).toBeVisible();
  await page.unroute("**/v1/devices");
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Belum ada perangkat di organisasi ini.")).toBeVisible();
  expect(w.consoleErrors.filter((e) => !/ERR_FAILED|Failed to load resource/.test(e))).toEqual([]);
});
