import { expect, type Locator, type Page, test } from "@playwright/test";
import { closeDb, newTenant, seedDevice, signInAs, startMock } from "./support";

test.afterAll(closeDb);

const SCHEMES = ["light", "dark"] as const;
const WIDTHS = [390, 1024];

/** Text contrast of one element as rendered right now, after any running transition has settled. */
async function settledContrast(el: Locator): Promise<{ ratio: number; fg: string; bg: string }> {
  return el.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((a) => a.finished.catch(() => null)));
    const parse = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: number[]) =>
      0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
    let bg = [255, 255, 255];
    for (let e: Element | null = node; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c.length === 3 || (c.length === 4 && (c[3] as number) > 0.99)) {
        bg = c;
        break;
      }
    }
    const fg = parse(getComputedStyle(node).color);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
    return {
      ratio: (hi + 0.05) / (lo + 0.05),
      fg: `rgb(${fg.join(",")})`,
      bg: `rgb(${bg.join(",")})`,
    };
  });
}

/** Every visible button-like control must hold 4.5:1 in rest, hover, keyboard focus and held-down (:active) states. */
async function auditStates(page: Page, where: string) {
  // Behind a modal dialog the page is inert, so only the dialog's own controls can be pressed.
  const scope = (await page.locator("dialog[open]").count()) > 0 ? "dialog[open] " : "";
  const controls = page.locator(`${scope}button:visible, ${scope}a.btn:visible`);
  const count = await controls.count();
  expect(count, `${where}: no controls found`).toBeGreaterThan(0);
  const failures: string[] = [];
  for (let i = 0; i < count; i++) {
    const el = controls.nth(i);
    const label = ((await el.innerText()) || (await el.getAttribute("aria-label")) || `#${i}`)
      .trim()
      .slice(0, 30);
    const disabled = await el.isDisabled();
    const check = async (state: string) => {
      const r = await settledContrast(el);
      // Disabled controls are exempt from WCAG, yet they stay readable here as a house rule.
      if (r.ratio < 4.5) failures.push(`${label} [${state}] ${r.ratio.toFixed(2)} (${r.fg} on ${r.bg})`);
    };
    await el.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await check("rest");
    if (disabled) continue;
    await el.hover();
    await check("hover");
    // Hold the press: the state is measured while the button is still down, then released off the control.
    await page.mouse.down();
    await check("active");
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await el.focus();
    await check("focus");
    await el.blur();
  }
  expect(failures, `${where}: control text below 4.5:1`).toEqual([]);
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`kontras tombol di semua keadaan (hover, fokus, tahan tekan, nonaktif): ${width}px tema ${scheme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        locale: "id-ID",
      });
      const page = await context.newPage();
      const mock = await startMock();
      const t = await newTenant(`st${width}${scheme}`);
      const { device } = await seedDevice(t, mock);

      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
      await auditStates(page, `login ${width} ${scheme}`);

      await signInAs(context, t);
      await page.goto(`/perangkat?d=${device.id}`);
      await expect(page.getByRole("region", { name: "Lembar probe" })).toBeVisible();
      await auditStates(page, `detail kosong ${width} ${scheme}`);

      await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
      await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
      await auditStates(page, `detail snapshot ${width} ${scheme}`);

      await page.goto("/perangkat");
      await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
      await expect(page.getByRole("dialog", { name: "Tambah perangkat" })).toBeVisible();
      await auditStates(page, `dialog tambah ${width} ${scheme}`);

      await mock.stop();
      await context.close();
    });
  }
}
