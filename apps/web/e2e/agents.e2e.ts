import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createLogger } from "@pantau/agent";
import { expect, test } from "@playwright/test";
import {
  API,
  closeDb,
  DEVICE_PASSWORD,
  DEVICE_USER,
  newMember,
  newTenant,
  noLeaks,
  seedDevice,
  signInAs,
  startMock,
  watch,
} from "./support";

test.afterAll(closeDb);

const dataDir = () => mkdtempSync(join(tmpdir(), "pantau-web-agent-"));
const quiet = createLogger("silent");
const fast = {
  statusIntervalMs: 100,
  pingIntervalMs: 500,
  pongTimeoutMs: 1000,
  ackTimeoutMs: 2000,
  backoff: () => 50,
};
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

test("pemilik membuat token pendaftaran di UI, agen sungguhan mendaftar dengannya, status tampil, cabut memutus agen", async ({
  page,
  context,
}) => {
  const mock = await startMock({ channels: 2 });
  const owner = await newTenant("ag-own");
  await seedDevice(owner, mock, "Perangkat Langsung");
  await signInAs(context, owner);
  const w = watch(page, [401]);
  await page.goto("/agen");
  await expect(page.getByRole("heading", { name: "Agen lokasi" })).toBeVisible();
  await expect(page.getByText("Belum ada agen di organisasi ini.")).toBeVisible();

  // mint a token through the UI; it is shown once, in a dialog
  await page.getByRole("button", { name: "Buat token pendaftaran" }).click();
  const dlg = page.getByRole("dialog", { name: "Token pendaftaran agen" });
  await dlg.getByLabel("Lokasi").selectOption({ label: "Lokasi Uji" });
  await dlg.getByRole("button", { name: "Buat token" }).click();
  const token = (await dlg.getByTestId("enroll-token").innerText()).trim();
  expect(token).toMatch(/^pae_[A-Za-z0-9_-]{43}$/);
  await expect(dlg.getByText(/Berlaku sampai/)).toBeVisible();
  await expect(dlg.getByText(/hanya ditampilkan sekali/i)).toBeVisible();
  await dlg.getByRole("button", { name: "Tutup", exact: true }).first().click();
  await expect(dlg).toBeHidden();
  // gone from the page once closed
  expect((await page.content()).includes(token)).toBe(false);

  // a real agent enrolls with it and connects
  const agent = await Agent.enroll({
    apiUrl: API,
    enrollToken: token,
    dataDir: dataDir(),
    name: "Agen UI",
    allowLoopback: true,
    allowInsecure: true,
    logger: quiet,
    client: fast,
  });
  agent.start();
  expect(await until(() => agent.client.state === "ready")).toBe(true);
  await agent.addDevice({
    name: "NVR Simulasi",
    host: mock.host,
    port: mock.port,
    username: DEVICE_USER,
    password: DEVICE_PASSWORD,
  });

  const card = page.getByRole("article", { name: "Agen UI" });
  // The page does not refresh itself, and the status that counts both cameras may arrive after the first load.
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 3000 });
    await expect(card.getByText(/Kamera terjangkau 2 dari 2/)).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect(card.getByText("Terhubung", { exact: true })).toBeVisible();
  await expect(card.getByText("Lokasi Uji")).toBeVisible();
  await expect(card.getByText(/Laporan terakhir pukul/)).toBeVisible();

  // the metadata the agent synced is in the normal device list, with no credentials anywhere
  await page.goto("/perangkat");
  await expect(page.getByRole("link", { name: /NVR Simulasi/ })).toBeVisible();
  await noLeaks(page, w, [DEVICE_PASSWORD, token, agent.identity.agentToken]);

  // revoke through the UI: confirm first, then the agent is cut off and says so
  let unauthorized = 0;
  agent.client.on("unauthorized", () => unauthorized++);
  await page.goto("/agen");
  await page.getByRole("button", { name: "Cabut agen Agen UI" }).click();
  const confirm = page.getByRole("dialog", { name: "Cabut agen?" });
  await expect(confirm.getByText(/tidak bisa tersambung lagi/)).toBeVisible();
  await confirm.getByRole("button", { name: "Cabut agen", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Agen UI" }).getByText("Dicabut", { exact: true }),
  ).toBeVisible();
  expect(await until(() => unauthorized === 1)).toBe(true);
  await expect(page.getByRole("button", { name: "Cabut agen Agen UI" })).toHaveCount(0);
  expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
  await agent.stop();
  await mock.stop();
});

test("pembatalan di dialog cabut tidak mencabut apa pun", async ({ page, context }) => {
  const mock = await startMock({ channels: 1 });
  const owner = await newTenant("ag-cancel");
  await seedDevice(owner, mock);
  const token = await mintToken(owner);
  const agent = await Agent.enroll({
    apiUrl: API,
    enrollToken: token,
    dataDir: dataDir(),
    name: "Agen Batal",
    allowLoopback: true,
    allowInsecure: true,
    logger: quiet,
    client: fast,
  });
  agent.start();
  await until(() => agent.client.state === "ready");
  await signInAs(context, owner);
  await page.goto("/agen");
  await page.getByRole("button", { name: "Cabut agen Agen Batal" }).click();
  const confirm = page.getByRole("dialog", { name: "Cabut agen?" });
  await confirm.getByRole("button", { name: "Batal" }).click();
  await expect(confirm).toBeHidden();
  await expect(
    page.getByRole("article", { name: "Agen Batal" }).getByText("Terhubung", { exact: true }),
  ).toBeVisible();
  expect(agent.client.state).toBe("ready");
  await agent.stop();
  await mock.stop();
});

async function mintToken(owner: Awaited<ReturnType<typeof newTenant>>): Promise<string> {
  const cookie = `${owner.cookie.name}=${owner.cookie.value}`;
  const sites = (await (await fetch(`${API}/v1/sites`, { headers: { cookie } })).json()) as {
    items: { id: string }[];
  };
  const res = await fetch(`${API}/v1/sites/${sites.items[0]?.id}/enrollments`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost:3100" },
    body: "{}",
  });
  return ((await res.json()) as { token: string }).token;
}

test("operator melihat agen tanpa tombol buat token atau cabut; penonton ditolak; tenant lain tidak melihat apa pun", async ({
  browser,
}) => {
  const mock = await startMock({ channels: 1 });
  const owner = await newTenant("ag-roles");
  const operator = await newMember(owner, "ag-op", "admin");
  const viewer = await newMember(owner, "ag-vw", "member");
  const other = await newTenant("ag-other");
  await seedDevice(owner, mock);
  const agent = await Agent.enroll({
    apiUrl: API,
    enrollToken: await mintToken(owner),
    dataDir: dataDir(),
    name: "Agen Peran",
    allowLoopback: true,
    allowInsecure: true,
    logger: quiet,
    client: fast,
  });
  agent.start();
  await until(() => agent.client.state === "ready");

  const opCtx = await browser.newContext({ locale: "id-ID" });
  await signInAs(opCtx, operator);
  const op = await opCtx.newPage();
  await op.goto("/agen");
  await expect(op.getByRole("article", { name: "Agen Peran" })).toBeVisible();
  await expect(op.getByRole("button", { name: "Buat token pendaftaran" })).toHaveCount(0);
  await expect(op.getByRole("button", { name: /^Cabut agen/ })).toHaveCount(0);

  const vwCtx = await browser.newContext({ locale: "id-ID" });
  await signInAs(vwCtx, viewer);
  const vw = await vwCtx.newPage();
  await expect(async () => {
    await vw.goto("/agen");
    await expect(vw.getByRole("link", { name: "Agen", exact: true })).toHaveCount(0);
  }).toPass();
  await expect(vw.getByText("Peran Anda tidak boleh melihat agen.")).toBeVisible();
  const forced = await vw.request.get("/v1/agents");
  expect(forced.status()).toBe(403);

  const otCtx = await browser.newContext({ locale: "id-ID" });
  await signInAs(otCtx, other);
  const ot = await otCtx.newPage();
  await ot.goto("/agen");
  await expect(ot.getByText("Belum ada agen di organisasi ini.")).toBeVisible();
  await expect(ot.getByText("Agen Peran")).toHaveCount(0);
  await agent.stop();
  await mock.stop();
  await opCtx.close();
  await vwCtx.close();
  await otCtx.close();
});
