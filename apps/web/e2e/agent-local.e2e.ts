import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { onvifGenericAdapter } from "../../../packages/adapters/src/index";
import { DeviceRegistry } from "../../agent/src/devices";
import { startLocalUi } from "../../agent/src/local-ui";
import { FileVault } from "../../agent/src/vault";
import { audit, expectClean } from "./audit";
import { DEVICE_PASSWORD, DEVICE_USER, startMock } from "./support";

const PIN = "24681357";
const SCHEMES = ["light", "dark"] as const;
const WIDTHS = [360, 1280];

async function agentUi() {
  const mock = await startMock();
  const dir = mkdtempSync(join(tmpdir(), "pantau-agent-e2e-"));
  const registry = new DeviceRegistry({
    dir,
    vault: FileVault.open(join(dir, "vault")),
    probe: (c) => onvifGenericAdapter.probe(c),
    allowLoopback: true,
    timeoutMs: 2000,
  });
  // Simulasi: a fixed candidate pointing at the mock, not a real multicast answer.
  const ui = await startLocalUi({
    registry,
    pin: PIN,
    discover: async () => [
      {
        host: "127.0.0.1",
        port: mock.port,
        xaddr: `http://127.0.0.1:${mock.port}/onvif/device_service`,
        endpointId: "urn:uuid:sim",
        name: "Perangkat Simulasi",
      },
    ],
  });
  return { mock, registry, ui, dir };
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`agen lokal: masuk, cari, tambah perangkat, tanpa kebocoran sandi: ${width}px tema ${scheme}`, async ({
      browser,
    }) => {
      const { mock, registry, ui } = await agentUi();
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        locale: "id-ID",
      });
      const page = await context.newPage();
      const logs: string[] = [];
      page.on("console", (m) => logs.push(m.text()));
      const requests: string[] = [];
      page.on("request", (r) => requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`));

      await page.goto(ui.url);
      await expect(page.getByRole("heading", { name: "Masuk dengan PIN" })).toBeVisible();
      expectClean(await audit(page), `masuk ${width} ${scheme}`);

      await page.getByLabel("PIN", { exact: true }).fill("00000000");
      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page.getByText("PIN salah.")).toBeVisible();
      expectClean(await audit(page), `pin salah ${width} ${scheme}`);

      await page.getByLabel("PIN", { exact: true }).fill(PIN);
      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page.getByRole("heading", { name: "Perangkat di agen ini" })).toBeVisible();
      expectClean(await audit(page), `kosong ${width} ${scheme}`);

      await page.getByRole("button", { name: "Cari perangkat" }).click();
      await expect(page.getByText("1 perangkat ditemukan.")).toBeVisible();
      await page.getByRole("button", { name: "Pakai 127.0.0.1" }).click();
      await expect(page.getByLabel("Alamat IP")).toHaveValue("127.0.0.1");
      await expect(page.getByLabel("Nama pengguna perangkat")).toBeFocused();

      await page.getByLabel("Nama pengguna perangkat").fill(DEVICE_USER);
      await page.getByLabel("Sandi perangkat").fill("Dummy-Wrong-Pw-1!");
      await page.getByRole("button", { name: "Uji dan simpan" }).click();
      await expect(page.getByText("Nama pengguna atau sandi perangkat ditolak.")).toBeVisible();
      await expect(page.getByLabel("Sandi perangkat")).toHaveValue("");
      expectClean(await audit(page), `galat ${width} ${scheme}`);

      await page.getByLabel("Sandi perangkat").fill(DEVICE_PASSWORD);
      await page.getByRole("button", { name: "Uji dan simpan" }).click();
      await expect(page.getByText(/Perangkat ditambahkan: \d+ kamera/)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Hapus / })).toBeVisible();
      await expect(page.getByLabel("Sandi perangkat")).toHaveValue("");
      expectClean(await audit(page), `berhasil ${width} ${scheme}`);

      // The password left the browser only as the body of one request to this agent, and nowhere else.
      expect(page.url()).not.toContain(DEVICE_PASSWORD);
      expect(page.url()).not.toContain(PIN);
      expect(logs.join("\n")).not.toContain(DEVICE_PASSWORD);
      for (const r of requests) expect(r.startsWith(`GET ${ui.url}`) || r.includes(ui.url)).toBe(true);
      expect(await page.content()).not.toContain(DEVICE_PASSWORD);
      const stored = await page.evaluate(() =>
        JSON.stringify([localStorage, sessionStorage, document.cookie]),
      );
      expect(stored).not.toContain(DEVICE_PASSWORD);
      expect(stored).not.toContain(PIN);
      expect(registry.list()).toHaveLength(1);

      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: /^Hapus / }).click();
      await expect(page.getByText("Belum ada perangkat.")).toBeVisible();
      expect(registry.list()).toHaveLength(0);

      await context.close();
      await ui.close();
      await mock.stop();
    });
  }
}
