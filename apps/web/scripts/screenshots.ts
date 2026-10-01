import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Captures the running Simulasi demo (pnpm demo) into docs/screenshots. Only dummy data is on screen.
const out = resolve(import.meta.dirname, "../../../docs/screenshots");
mkdirSync(out, { recursive: true });
const base = process.env.PANTAU_URL ?? "http://localhost:3100";

const browser = await chromium.launch();
type Scheme = "light" | "dark";

async function run(tag: string, width: number, height: number, scheme: Scheme, shots: Set<string>) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    locale: "id-ID",
    timezoneId: "Asia/Makassar",
  });
  const page = await ctx.newPage();
  const snap = async (name: string, full = false) => {
    if (shots.has(name)) await page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: full });
  };
  await page.goto(`${base}/login`);
  await snap("masuk");
  await page.getByRole("button", { name: "Isi akun simulasi" }).click();
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("button", { name: /Tambah perangkat/ })
    .first()
    .waitFor();
  await snap("perangkat-kosong");
  await page
    .getByRole("button", { name: /Tambah perangkat/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Simulasi NVR 2 kanal" }).click();
  if (await page.getByLabel("Nama lokasi baru").isVisible())
    await page.getByLabel("Nama lokasi baru").fill("Lab Simulasi");
  await snap("tambah-perangkat");
  await page.getByRole("button", { name: "Tambah dan probe" }).click();
  await page.getByRole("region", { name: "Lembar probe" }).waitFor();
  await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
  await page.locator("img[alt^='Snapshot kamera']").waitFor();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await snap("snapshot");
  if (width >= 720) {
    await page.getByRole("link", { name: "Audit", exact: true }).click();
    await page.getByText("Snapshot diambil").first().waitFor();
    await snap("audit");
  }
  await ctx.close();
}

await run(
  "desktop-gelap",
  1440,
  900,
  "dark",
  new Set(["masuk", "perangkat-kosong", "tambah-perangkat", "snapshot", "audit"]),
);
await run("desktop-terang", 1440, 900, "light", new Set(["snapshot"]));
await run("ponsel-terang", 390, 844, "light", new Set(["masuk", "snapshot"]));
await run("ponsel-gelap", 390, 844, "dark", new Set(["snapshot"]));
await browser.close();
console.log("screenshots written to", out);
