import { expect, type Page, test } from "@playwright/test";
import { closeDb, enrollAgentViaApi, newTenant, seedDevice, signInAs, startMock } from "./support";

test.afterAll(closeDb);

const SCHEMES = ["light", "dark"] as const;

/** Walk the real Tab order and measure the focus ring of each stop against the surface it is drawn on. */
async function auditFocus(page: Page, where: string) {
  const stops = await page.evaluate(
    () => document.querySelectorAll("a[href],button,input,select,textarea").length,
  );
  const bad: string[] = [];
  const seen = new Set<string>();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < stops + 2; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const parse = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
      const lin = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = (c: number[]) =>
        0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
      let bg = [255, 255, 255];
      for (let e: Element | null = el.parentElement; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || (c.length === 4 && (c[3] as number) > 0.99)) {
          bg = c;
          break;
        }
      }
      const cs = getComputedStyle(el);
      const ring = parse(cs.outlineColor);
      const [hi, lo] = [lum(ring), lum(bg)].sort((a, b) => b - a) as [number, number];
      const rect = el.getBoundingClientRect();
      return {
        id: `${el.tagName.toLowerCase()}:${(el.innerText || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 30)}`,
        style: cs.outlineStyle,
        width: Number.parseFloat(cs.outlineWidth),
        ratio: (hi + 0.05) / (lo + 0.05),
        onScreen: rect.bottom > 0 && rect.top < innerHeight,
      };
    });
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.style === "none" || r.width < 2) bad.push(`${r.id} ring ${r.style} ${r.width}px`);
    else if (r.ratio < 3) bad.push(`${r.id} ring ${r.ratio.toFixed(2)}:1`);
    if (!r.onScreen) bad.push(`${r.id} focused but scrolled out of view`);
  }
  expect(seen.size, `${where}: Tab reached nothing`).toBeGreaterThan(0);
  expect(bad, `${where}: focus indicator problems`).toEqual([]);
}

for (const scheme of SCHEMES) {
  test(`fokus keyboard terlihat (3:1, tidak keluar layar) di semua layar: tema ${scheme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 800 },
      colorScheme: scheme,
      locale: "id-ID",
    });
    const page = await context.newPage();
    const mock = await startMock();
    const t = await newTenant(`fk${scheme}`);
    const { device } = await seedDevice(t, mock);

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
    await auditFocus(page, `login ${scheme}`);
    await signInAs(context, t);
    await page.goto(`/perangkat?d=${device.id}`);
    await expect(page.getByRole("region", { name: "Lembar probe" })).toBeVisible();
    await auditFocus(page, `detail ${scheme}`);
    await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
    await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
    await auditFocus(page, `snapshot ${scheme}`);
    await page.goto("/audit");
    await expect(page.getByText("Snapshot diambil").first()).toBeVisible();
    await auditFocus(page, `audit ${scheme}`);
    await page.goto("/organisasi");
    await expect(page.getByRole("heading", { name: "Pilih organisasi" })).toBeVisible();
    await auditFocus(page, `organisasi ${scheme}`);
    await page.goto("/akses");
    await expect(page.getByRole("heading", { name: "Akses kamera" })).toBeVisible();
    await auditFocus(page, `akses ${scheme}`);
    await page.goto("/keamanan");
    await expect(page.getByRole("heading", { name: "Keamanan akun" })).toBeVisible();
    await auditFocus(page, `keamanan ${scheme}`);
    await enrollAgentViaApi(t, "Agen Fokus");
    await page.goto("/agen");
    await expect(page.getByRole("article", { name: "Agen Fokus" })).toBeVisible();
    await auditFocus(page, `agen ${scheme}`);
    await mock.stop();
    await context.close();
  });

  test(`lebar 320px dan perbesaran 200% tidak memotong atau menggulir ke samping: tema ${scheme}`, async ({
    browser,
  }) => {
    // 200% zoom on a 640px window leaves 320 CSS px; 320 on a phone is the WCAG reflow floor.
    const context = await browser.newContext({
      viewport: { width: 320, height: 700 },
      colorScheme: scheme,
      locale: "id-ID",
    });
    const page = await context.newPage();
    const mock = await startMock();
    const t = await newTenant(`rf${scheme}`);
    const { device } = await seedDevice(t, mock);
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
    expect(await overflow(), "login overflows at 320").toBeLessThanOrEqual(0);
    await signInAs(context, t);
    for (const path of [
      `/perangkat?d=${device.id}`,
      "/perangkat",
      "/audit",
      "/organisasi",
      "/akses",
      "/keamanan",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await overflow(), `${path} overflows at 320`).toBeLessThanOrEqual(0);
    }
    await page.goto(`/perangkat?d=${device.id}`);
    await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
    await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
    expect(await overflow(), "snapshot detail overflows at 320").toBeLessThanOrEqual(0);
    await page.goto("/perangkat");
    await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Tambah perangkat" });
    await expect(dlg).toBeVisible();
    const box = await dlg.evaluate((d) => {
      const r = d.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: document.documentElement.clientWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.vw);
    await mock.stop();
    await context.close();
  });
}

test("forced-colors: tombol dan kolom tetap berbingkai dan fokus tetap terlihat", async ({ browser }) => {
  const context = await browser.newContext({ forcedColors: "active", locale: "id-ID" });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
  const frames = await page.evaluate(() =>
    [...document.querySelectorAll("button,input")]
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        const cs = getComputedStyle(e);
        return `${e.tagName}:${cs.borderTopStyle}:${cs.borderTopWidth}`;
      }),
  );
  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) expect(f, "control lost its border in forced colors").not.toMatch(/:none:|:0px$/);
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement as Element);
    return `${cs.outlineStyle}:${cs.outlineWidth}`;
  });
  expect(ring).not.toMatch(/^none|:0px$/);
  await context.close();
});
