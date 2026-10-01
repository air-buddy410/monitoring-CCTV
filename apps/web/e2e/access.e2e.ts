import { expect, test } from "@playwright/test";
import {
  closeDb,
  db,
  loginUi,
  newMember,
  newTenant,
  seedDevice,
  signInAs,
  startMock,
  USER_PASSWORD,
  WEB,
  watch,
} from "./support";

test.afterAll(closeDb);

test("penonton hanya melihat: tidak ada aksi terlarang, server menolak jika dipaksa", async ({
  page,
  context,
}) => {
  const mock = await startMock();
  const owner = await newTenant("own");
  const viewer = await newMember(owner, "viewer", "member");
  const { device, cameras } = await seedDevice(owner, mock);
  await signInAs(context, viewer);
  const w = watch(page, [403]);

  await page.goto(`/perangkat?d=${device.id}`);
  await expect(page.getByRole("link", { name: /Perangkat Uji/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lembar probe" })).toBeVisible();
  await expect(page.getByText("Penonton", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Tambah perangkat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Ambil snapshot/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
  await expect(page.getByText("Mengambil snapshot memerlukan peran operator.")).toBeVisible();

  // Audit by direct URL: the server's 403 is shown as a forbidden state.
  await page.goto("/audit");
  await expect(page.getByText("Hanya pemilik organisasi yang boleh membaca audit.")).toBeVisible();

  // Forcing the endpoints past the UI is refused by the server and never reaches the camera.
  const before = mock.snapshotRequestCount();
  const snap = await page.request.post(`/v1/cameras/${cameras[0]?.id}/snapshot`, {
    headers: { origin: WEB },
  });
  expect(snap.status()).toBe(403);
  const add = await page.request.post("/v1/devices", {
    headers: { origin: WEB },
    data: { siteId: "x", name: "n", host: "127.0.0.1", port: 80, username: "u", password: "p" },
  });
  expect(add.status()).toBe(403);
  expect(mock.snapshotRequestCount()).toBe(before);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("operator menambah perangkat dan mengambil snapshot, tetapi tidak membaca audit", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const owner = await newTenant("own2");
  const operator = await newMember(owner, "operator", "admin");
  const { device } = await seedDevice(owner, mock, "Milik Pemilik");
  await signInAs(context, operator);
  const w = watch(page, [403]);

  await page.goto(`/perangkat?d=${device.id}`);
  await expect(page.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();

  const second = await startMock({ channels: 1, model: "MV-CAM-1" });
  await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Tambah perangkat" });
  await dialog.getByLabel("Nama perangkat").fill("Dari Operator");
  await dialog.getByLabel("Alamat IP").fill(second.host);
  await dialog.getByLabel("Port").fill(String(second.port));
  await dialog.getByLabel("Nama pengguna perangkat").fill("dummy-admin");
  await dialog.getByLabel("Kata sandi perangkat").fill("Dummy-Sentinel-Pw-7391!");
  await dialog.getByRole("button", { name: "Tambah dan probe" }).click();
  await expect(page.getByRole("region", { name: "Lembar probe" }).getByText("MV-CAM-1")).toBeVisible();

  await page.goto("/audit");
  await expect(page.getByText("Hanya pemilik organisasi yang boleh membaca audit.")).toBeVisible();
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
  await second.stop();
});

test("tenant B tidak melihat data tenant A (UI dan API)", async ({ page, context }) => {
  const mock = await startMock();
  const a = await newTenant("tenA");
  const b = await newTenant("tenB");
  const { device, cameras } = await seedDevice(a, mock, "Rahasia Tenant A");
  await signInAs(context, b);
  const w = watch(page, [404]);

  await page.goto("/perangkat");
  await expect(page.getByText("Belum ada perangkat di organisasi ini.")).toBeVisible();
  await expect(page.getByText("Rahasia Tenant A")).toHaveCount(0);

  await page.goto(`/perangkat?d=${device.id}`);
  await expect(page.getByText("Perangkat ini tidak ditemukan di organisasi aktif.")).toBeVisible();
  await expect(page.getByText("Rahasia Tenant A")).toHaveCount(0);

  const before = mock.snapshotRequestCount();
  expect((await page.request.get(`/v1/devices/${device.id}`)).status()).toBe(404);
  expect((await page.request.get(`/v1/cameras/${cameras[0]?.id}`)).status()).toBe(404);
  expect(
    (
      await page.request.post(`/v1/cameras/${cameras[0]?.id}/snapshot`, { headers: { origin: WEB } })
    ).status(),
  ).toBe(404);
  expect(mock.snapshotRequestCount()).toBe(before);
  const list = (await (await page.request.get("/v1/devices")).json()) as { items: unknown[] };
  expect(list.items).toEqual([]);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("sesi berakhir: kembali ke login dengan pesan, lalu lanjut ke halaman semula", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const t = await newTenant("exp");
  const { device } = await seedDevice(t, mock);
  await signInAs(context, t);
  const w = watch(page, [401]);

  await page.goto(`/perangkat?d=${device.id}`);
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();

  await db().query(`delete from "session" where user_id = $1`, [t.userId]);
  await page.getByRole("button", { name: "Ambil snapshot lagi" }).click();
  await expect(page).toHaveURL(/\/login\?expired=1&next=/);
  await expect(page.getByText("Sesi Anda berakhir.")).toBeVisible();

  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Kata sandi").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  // The final state matters, not a URL that is only passed through on the way.
  await expect(page.getByRole("region", { name: "Lembar probe" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`localhost:3100/perangkat\\?d=${device.id}`));
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("login: kata sandi salah ditolak dengan pesan jelas dan kolom sandi dikosongkan", async ({ page }) => {
  const t = await newTenant("lg");
  const w = watch(page, [401]);
  await page.goto("/login");
  await page.getByRole("button", { name: "Belum punya akun? Daftar" }).click();
  await expect(page.getByRole("heading", { name: "Buat akun" })).toBeVisible();
  await page.getByRole("button", { name: "Sudah punya akun? Masuk" }).click();
  await expect(page.getByRole("heading", { name: "Masuk", exact: true })).toBeVisible();
  await loginUi(page, t.email, "Wrong-Dummy-Login-0000!");
  await expect(page.getByText("Email atau kata sandi salah.")).toBeVisible();
  await expect(page.getByLabel("Kata sandi")).toHaveValue("");
  await expect(page).toHaveURL(/\/login/);
  await loginUi(page, t.email);
  await expect(page).toHaveURL(/\/perangkat$/);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
});

test("halaman terproteksi mengarahkan tamu ke login dan tautan next tidak bisa keluar situs", async ({
  page,
}) => {
  await page.goto("/perangkat");
  await expect(page).toHaveURL(/\/login\?next=%2Fperangkat/);
  await page.goto("/login?next=//evil.test");
  const t = await newTenant("nx");
  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Kata sandi").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await expect(page).toHaveURL(/localhost:3100\/perangkat/);
});
