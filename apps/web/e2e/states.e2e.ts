import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  closeDb,
  enableTotpViaApi,
  enrollAgentViaApi,
  grantAccess,
  loginUi,
  newMember,
  newTenant,
  seedDevice,
  signInAs,
  startMock,
  USER_PASSWORD,
} from "./support";

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

for (const scheme of SCHEMES) {
  test(`tombol primer: tidak ada frame berkontras rendah saat berganti nonaktif ke aktif: tema ${scheme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: scheme, locale: "id-ID" });
    const page = await context.newPage();
    // Hold the sign-in request so the button stays disabled for many frames, then answer with a refusal.
    await page.route("**/api/auth/sign-in/email", async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "x" }),
      });
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill("frame@example.test");
    await page.getByLabel("Kata sandi").fill("Dummy-Frame-Pw-1234");
    // Sample every animation frame from before the click until well after the button is enabled again.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: { ratio: number; disabled: boolean }[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lin = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = (c: number[]) =>
        0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
      const tick = () => {
        const b = document.querySelector<HTMLButtonElement>("form button[type=submit]");
        if (b) {
          const cs = getComputedStyle(b);
          const [hi, lo] = [lum(parse(cs.color)), lum(parse(cs.backgroundColor))].sort((a, c) => c - a) as [
            number,
            number,
          ];
          w.__frames.push({ ratio: (hi + 0.05) / (lo + 0.05), disabled: b.disabled });
        }
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page.getByText("Email atau kata sandi salah.")).toBeVisible();
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: { ratio: number; disabled: boolean }[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
    expect(
      frames.some((f) => f.disabled),
      "the disabled phase was never sampled",
    ).toBe(true);
    expect(frames.length).toBeGreaterThan(20);
    const worst = Math.min(...frames.map((f) => f.ratio));
    expect(worst, `lowest contrast over ${frames.length} frames`).toBeGreaterThanOrEqual(4.5);
    await context.close();
  });
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`kontras tombol di Keamanan, Akses, dan langkah 2FA: ${width}px tema ${scheme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        locale: "id-ID",
      });
      const page = await context.newPage();
      const mock = await startMock({ channels: 2 });
      const owner = await newTenant(`sx${width}${scheme}`);
      const operator = await newMember(owner, "sxop", "admin");
      const { cameras } = await seedDevice(owner, mock);
      await grantAccess(owner, operator.userId, "camera", cameras[0]?.id as string, "operate");

      const guarded = await newTenant(`sxg${width}${scheme}`);
      await enableTotpViaApi(guarded);
      await loginUi(page, guarded.email);
      await expect(page.getByRole("heading", { name: "Verifikasi dua langkah", exact: true })).toBeVisible();
      await auditStates(page, `langkah 2FA ${width} ${scheme}`);

      await context.clearCookies();
      await signInAs(context, owner);
      await page.goto("/keamanan");
      await expect(page.getByRole("heading", { name: "Keamanan akun" })).toBeVisible();
      await auditStates(page, `keamanan mati ${width} ${scheme}`);
      await page.getByLabel("Kata sandi akun, untuk memulai").fill(USER_PASSWORD);
      await page.getByRole("button", { name: "Mulai aktifkan" }).click();
      await expect(page.getByRole("img", { name: "Kode QR untuk aplikasi autentikator" })).toBeVisible();
      await auditStates(page, `keamanan setup ${width} ${scheme}`);

      await page.goto("/akses");
      await expect(page.getByRole("button", { name: /^Cabut akses/ }).first()).toBeVisible();
      await auditStates(page, `akses pemilik ${width} ${scheme}`);
      await page.getByRole("button", { name: "Beri akses" }).click();
      await expect(page.getByRole("dialog", { name: "Beri akses" })).toBeVisible();
      await auditStates(page, `dialog beri akses ${width} ${scheme}`);
      await page.keyboard.press("Escape");
      await enrollAgentViaApi(owner, "Agen Kontras");
      await page.goto("/agen");
      await expect(page.getByRole("article", { name: "Agen Kontras" })).toBeVisible();
      await auditStates(page, `agen ${width} ${scheme}`);
      await page.getByRole("button", { name: "Buat token pendaftaran" }).click();
      await expect(page.getByRole("dialog", { name: "Token pendaftaran agen" })).toBeVisible();
      await auditStates(page, `dialog token ${width} ${scheme}`);
      await mock.stop();
      await context.close();
    });
  }
}
