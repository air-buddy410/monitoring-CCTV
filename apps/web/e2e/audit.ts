import { expect, type Page } from "@playwright/test";

export interface Report {
  overflow: boolean;
  small: string[];
  clipped: string[];
  lowContrast: string[];
}

/** Layout and contrast audit run inside the page: overflow, 44px targets, clipped controls, text contrast. */
export async function audit(page: Page): Promise<Report> {
  return page.evaluate(async () => {
    // Measure settled colors; mid-transition frames are covered by the per-frame test in states.e2e.ts.
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)));
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
      // A checkbox or radio is activated through its label, so the label's box is the touch target.
      const box =
        el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
          ? (el.closest("label") ?? el)
          : el;
      const r = box.getBoundingClientRect();
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

export function expectClean(r: Report, where: string) {
  expect(r.overflow, `${where}: horizontal overflow`).toBe(false);
  expect(r.small, `${where}: targets under 44px`).toEqual([]);
  expect(r.clipped, `${where}: controls outside the viewport`).toEqual([]);
  expect(r.lowContrast, `${where}: text below WCAG AA`).toEqual([]);
}
