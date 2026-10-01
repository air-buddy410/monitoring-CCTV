import { expect, type Page, test } from "@playwright/test";
import { closeDb, newTenant, seedDevice, signInAs, startMock, watch } from "./support";

test.afterAll(closeDb);

const WIDTHS = [360, 390, 768, 1024, 1440];
const SCHEMES = ["light", "dark"] as const;

interface Report {
  overflow: boolean;
  small: string[];
  clipped: string[];
  lowContrast: string[];
}

/** Layout and contrast audit run inside the page: overflow, 44px targets, clipped controls, text contrast. */
async function audit(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = {
      overflow: document.documentElement.scrollWidth > vw,
      small: [] as string[],
      clipped: [] as string[],
      lowContrast: [] as string[],
    };
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}:${((el as HTMLElement).innerText || el.getAttribute("aria-label") || el.id || "").trim().slice(0, 40)}`;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    for (const el of document.querySelectorAll("a[href],button,input,select,textarea,summary")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5)
        out.small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.left < -0.5 || r.right > vw + 0.5)
        out.clipped.push(`${name(el)} ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    }
    const parse = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (c: number[]) =>
      0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
    const bgOf = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || (c.length === 4 && (c[3] as number) > 0.99)) return c;
      }
      return [255, 255, 255];
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (
        !el ||
        seen.has(el) ||
        !(n.textContent ?? "").trim() ||
        !visible(el) ||
        el.closest("script,style,[hidden]")
      )
        continue;
      seen.add(el);
      if (el.closest("img")) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = Number.parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.lowContrast.push(`${name(el)} ${ratio.toFixed(2)}`);
    }
    return out;
  });
}

function expectClean(r: Report, where: string) {
  expect(r.overflow, `${where}: horizontal overflow`).toBe(false);
  expect(r.small, `${where}: targets under 44px`).toEqual([]);
  expect(r.clipped, `${where}: controls outside the viewport`).toEqual([]);
  expect(r.lowContrast, `${where}: text below WCAG AA`).toEqual([]);
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`tata letak, target sentuh, kontras dan konsol bersih: ${width}px tema ${scheme}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: width < 720 ? 800 : 900 },
        colorScheme: scheme,
        locale: "id-ID",
        timezoneId: "Asia/Makassar",
      });
      const page = await context.newPage();
      const w = watch(page, [401, 404]);
      const mock = await startMock();
      const t = await newTenant(`lay${width}${scheme}`);
      const { device } = await seedDevice(t, mock);

      // Login screen (no session) in the current theme.
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Masuk" })).toBeVisible();
      expectClean(await audit(page), `login ${width} ${scheme}`);
      await page.getByRole("button", { name: "Belum punya akun? Daftar" }).click();
      expectClean(await audit(page), `daftar ${width} ${scheme}`);

      await signInAs(context, t);
      // Workspace: list only, then device with a real snapshot.
      await page.goto("/perangkat");
      await expect(page.getByRole("link", { name: /Perangkat Uji/ })).toBeVisible();
      expectClean(await audit(page), `daftar perangkat ${width} ${scheme}`);

      await page.goto(`/perangkat?d=${device.id}`);
      await expect(page.getByRole("region", { name: "Lembar probe" })).toBeVisible();
      expectClean(await audit(page), `detail kosong ${width} ${scheme}`);
      await page.getByRole("button", { name: "Ambil snapshot", exact: true }).click();
      await expect(page.locator("img[alt^='Snapshot kamera']")).toBeVisible();
      expectClean(await audit(page), `detail snapshot ${width} ${scheme}`);

      // Last content must stay reachable above the fixed action bar on phones.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const lastBottom = await page.evaluate(() => {
        const last = [...document.querySelectorAll("main *")]
          .filter((e) => e.getBoundingClientRect().height > 0)
          .pop() as Element;
        return last.getBoundingClientRect().bottom;
      });
      const barTop = await page.evaluate(() => {
        const bar = document.querySelector("[aria-label='Aksi snapshot']") as HTMLElement;
        return getComputedStyle(bar).position === "fixed"
          ? bar.getBoundingClientRect().top
          : Number.POSITIVE_INFINITY;
      });
      expect(lastBottom, `${width}: content hidden under the action bar`).toBeLessThanOrEqual(barTop + 0.5);
      await page.evaluate(() => window.scrollTo(0, 0));

      // Dialogs.
      if (width < 720) {
        await page.getByRole("button", { name: "Menu" }).click();
        expectClean(await audit(page), `menu ${width} ${scheme}`);
        await page.keyboard.press("Escape");
      }
      await page.goto("/perangkat");
      await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
      const addDialog = page.getByRole("dialog", { name: "Tambah perangkat" });
      await expect(addDialog).toBeVisible();
      const gap = await addDialog.evaluate((d) => {
        const r = d.getBoundingClientRect();
        return { left: r.left, right: document.documentElement.clientWidth - r.right, top: r.top };
      });
      expect(Math.abs(gap.left - gap.right), `${width}: dialog not centered`).toBeLessThanOrEqual(2);
      expect(gap.left, `${width}: dialog touches the edge`).toBeGreaterThanOrEqual(8);
      expect(gap.top).toBeGreaterThanOrEqual(8);
      expectClean(await audit(page), `dialog tambah ${width} ${scheme}`);
      await page.keyboard.press("Escape");
      if (width < 720) {
        await page.getByRole("button", { name: /^Saring/ }).click();
        expectClean(await audit(page), `lembar saring ${width} ${scheme}`);
        await page.keyboard.press("Escape");
      }

      await page.goto("/audit");
      await expect(page.getByRole("heading", { name: "Audit" })).toBeVisible();
      await expect(page.getByText("Snapshot diambil").first()).toBeVisible();
      expectClean(await audit(page), `audit ${width} ${scheme}`);

      await page.goto("/organisasi");
      await expect(page.getByRole("heading", { name: "Pilih organisasi" })).toBeVisible();
      expectClean(await audit(page), `organisasi ${width} ${scheme}`);

      expect(w.consoleErrors, w.consoleErrors.join("\n")).toEqual([]);
      await mock.stop();
      await context.close();
    });
  }
}

test("tema: tombol mengganti tema, pilihan bertahan setelah muat ulang, kedua tema berwarna sesuai token", async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: "light", locale: "id-ID" });
  const page = await context.newPage();
  const t = await newTenant("tema");
  await signInAs(context, t);
  await page.goto("/perangkat");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe("rgb(243, 240, 232)");
  const toggle = page.getByRole("button", { name: /Mode gelap/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await bg()).toBe("rgb(17, 16, 14)");
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await bg()).toBe("rgb(17, 16, 14)");
  await page.getByRole("button", { name: /Mode gelap/ }).click();
  expect(await bg()).toBe("rgb(243, 240, 232)");
  await context.close();
});

test("reduced motion: tidak ada animasi atau transisi", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", locale: "id-ID" });
  const page = await context.newPage();
  const t = await newTenant("rm");
  await signInAs(context, t);
  await page.goto("/perangkat");
  await page.getByRole("button", { name: "Tambah perangkat" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Tambah perangkat" });
  await expect(dialog).toBeVisible();
  const style = await dialog.evaluate((d) => ({
    anim: getComputedStyle(d).animationName,
    dur: getComputedStyle(d).animationDuration,
  }));
  expect(style.anim === "none" || style.dur === "0s").toBe(true);
  const trans = await page
    .getByRole("button", { name: "Batal" })
    .evaluate((b) => getComputedStyle(b).transitionDuration);
  expect(trans.split(",").every((x) => x.trim() === "0s")).toBe(true);
  await context.close();
});
