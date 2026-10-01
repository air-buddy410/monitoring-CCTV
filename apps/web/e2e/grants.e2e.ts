import { expect, test } from "@playwright/test";
import {
  closeDb,
  grantAccess,
  newMember,
  newTenant,
  seedDevice,
  signInAs,
  startMock,
  WEB,
  watch,
} from "./support";

test.afterAll(closeDb);

test("pemilik memberi dan mencabut akses; operator mengikuti: tanpa akses ditolak, dengan akses bisa snapshot", async ({
  browser,
}) => {
  const mock = await startMock({ channels: 2 });
  const owner = await newTenant("gr-own");
  const operator = await newMember(owner, "gr-op", "admin");
  const { device, cameras } = await seedDevice(owner, mock, "Alat Akses");

  // owner grants through the UI
  const ownerCtx = await browser.newContext({ locale: "id-ID" });
  await signInAs(ownerCtx, owner);
  const op = await ownerCtx.newPage();
  const ow = watch(op);
  await op.goto("/akses");
  await expect(op.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
  await expect(op.getByText("Belum ada operator atau penonton yang diberi akses.").first()).toBeVisible();
  await op.getByRole("button", { name: "Beri akses" }).click();
  const dlg = op.getByRole("dialog", { name: "Beri akses" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("Anggota").selectOption({ label: "Pengguna gr-op (Operator)" });
  await dlg.getByLabel("Kamera", { exact: true }).selectOption({ index: 0 });
  await dlg.getByLabel("Izin").selectOption("operate");
  await dlg.getByRole("button", { name: "Beri akses" }).click();
  await expect(dlg).toBeHidden();
  await expect(op.getByRole("button", { name: /^Cabut akses .* ke kamera/ })).toHaveCount(1);
  expect(ow.consoleErrors, ow.consoleErrors.join("\n")).toEqual([]);

  // the operator can now take a snapshot of that camera
  const opCtx = await browser.newContext({ locale: "id-ID" });
  await signInAs(opCtx, operator);
  const p = await opCtx.newPage();
  const w = watch(p, [403]);
  await p.goto(`/perangkat?d=${device.id}&c=${cameras[0]?.id}`);
  await p.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await expect(p.locator("img[alt^='Snapshot kamera']")).toBeVisible();

  // owner revokes: the operator is refused by the server at once and the UI explains it after a reload
  await op.getByRole("button", { name: /^Cabut akses .* ke kamera/ }).click();
  await expect(op.getByRole("button", { name: /^Cabut akses/ })).toHaveCount(0);
  const before = mock.snapshotRequestCount();
  const forced = await p.request.post(`/v1/cameras/${cameras[0]?.id}/snapshot`, { headers: { origin: WEB } });
  expect(forced.status()).toBe(403);
  expect((await forced.json()).code).toBe("camera_not_granted");
  expect(mock.snapshotRequestCount()).toBe(before);
  await p.reload();
  // Without any grant the device is not visible at all: not just a disabled button.
  await expect(p.getByRole("button", { name: /Ambil snapshot/ })).toHaveCount(0);
  await expect(p.getByText("Perangkat ini tidak ditemukan di organisasi aktif.")).toBeVisible();
  const list = await p.request.get("/v1/cameras");
  expect((await list.json()).items).toEqual([]);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await ownerCtx.close();
  await opCtx.close();
  await mock.stop();
});

test("akses lokasi berlaku untuk semua kamera di lokasi itu; penonton hanya melihat, tidak pernah operasi", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 2 });
  const owner = await newTenant("gr-site");
  const viewer = await newMember(owner, "gr-view", "member");
  const { cameras } = await seedDevice(owner, mock);
  const siteId = (
    (await (
      await fetch("http://localhost:3101/v1/cameras", {
        headers: { cookie: `${owner.cookie.name}=${owner.cookie.value}` },
      })
    ).json()) as {
      items: { siteId: string }[];
    }
  ).items[0]?.siteId as string;
  await grantAccess(owner, viewer.userId, "site", siteId, "operate");
  await signInAs(context, viewer);
  await page.goto("/akses");
  await expect(page.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
  const rows = page.getByRole("row");
  // viewer is capped at "Lihat" even though the grant says operate
  await expect(rows.filter({ hasText: cameras[0]?.name as string }).getByText("Lihat")).toBeVisible();
  await expect(page.getByText("Operasi", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Beri akses" })).toHaveCount(0);
  await mock.stop();
});

test("operator tanpa akses: perangkat dan kamera tidak tampil sama sekali, halaman Akses menjelaskannya", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const owner = await newTenant("gr-none");
  const operator = await newMember(owner, "gr-none-op", "admin");
  const { device, cameras } = await seedDevice(owner, mock);
  await signInAs(context, operator);
  const w = watch(page, [403]);
  await page.goto("/perangkat");
  await expect(page.getByText("Belum ada perangkat yang bisa Anda lihat.")).toBeVisible();
  await page.goto(`/perangkat?d=${device.id}`);
  await expect(page.getByText("Perangkat ini tidak ditemukan di organisasi aktif.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Lembar probe" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Ambil snapshot/ })).toHaveCount(0);
  await page.goto("/akses");
  await expect(page.getByText("Belum ada kamera yang diberi akses kepada Anda.")).toBeVisible();
  await expect(page.getByText(cameras[0]?.name as string)).toHaveCount(0);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await mock.stop();
});

test("isolasi tenant di UI: pemilik B tidak melihat kamera atau akses milik A", async ({ page, context }) => {
  const mock = await startMock({ channels: 1 });
  const a = await newTenant("gr-a");
  const aOp = await newMember(a, "gr-a-op", "admin");
  const { cameras } = await seedDevice(a, mock, "Rahasia A");
  await grantAccess(a, aOp.userId, "camera", cameras[0]?.id as string, "operate");
  const b = await newTenant("gr-b");
  await signInAs(context, b);
  await page.goto("/akses");
  await expect(page.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
  await expect(page.getByText("Belum ada lokasi.")).toBeVisible();
  await expect(page.getByText("Rahasia A")).toHaveCount(0);
  await expect(page.getByText(cameras[0]?.name as string)).toHaveCount(0);
  // forcing A's grant endpoints from B's session changes nothing
  const del = await page.request.delete(`/v1/grants/${"grt_00000000000000000000000000000000"}`, {
    headers: { origin: WEB },
  });
  expect(del.status()).toBe(404);
  await mock.stop();
});

test("dialog Beri akses: Escape menutup, fokus kembali ke pemicu, bisa dioperasikan dengan keyboard", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 1 });
  const owner = await newTenant("gr-kbd");
  await newMember(owner, "gr-kbd-op", "admin");
  await seedDevice(owner, mock);
  await signInAs(context, owner);
  await page.goto("/akses");
  const trigger = page.getByRole("button", { name: "Beri akses" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Beri akses" });
  await expect(dlg).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(trigger).toBeFocused();
  await mock.stop();
});
