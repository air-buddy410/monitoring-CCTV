import type { SVGProps } from "react";

// Hand-drawn glyph set: mitered joins and square caps, 2px stroke, so icons share the crop-mark language
// instead of a stock rounded library look. All are decorative; the visible label carries the meaning.
function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export const GlyphSearch = () => (
  <Svg>
    <path d="M3 3h8v8H3z M11 11l4 4" />
  </Svg>
);
export const GlyphClose = () => (
  <Svg>
    <path d="M3 3l12 12 M15 3L3 15" />
  </Svg>
);
export const GlyphRepeat = () => (
  <Svg>
    <path d="M15 9a6 6 0 1 1-2-4.5 M15 2v4h-4" />
  </Svg>
);
export const GlyphExpand = () => (
  <Svg>
    <path d="M2 7V2h5 M11 2h5v5 M16 11v5h-5 M7 16H2v-5" />
  </Svg>
);
export const GlyphDownload = () => (
  <Svg>
    <path d="M9 2v9 M5 7l4 4 4-4 M3 15h12" />
  </Svg>
);

export type CapState = "ya" | "tidak" | "belum-diuji";

/** Three different shapes so state never depends on color: check, cross, open ring. */
export function StateGlyph({ state }: { state: CapState }) {
  if (state === "ya")
    return (
      <Svg style={{ color: "var(--ok)" }}>
        <path d="M3 9l4 4 8-9" />
      </Svg>
    );
  if (state === "tidak")
    return (
      <Svg style={{ color: "var(--muted)" }}>
        <path d="M4 4l10 10 M14 4L4 14" />
      </Svg>
    );
  return (
    <Svg style={{ color: "var(--muted)" }} strokeDasharray="3 2">
      <circle cx="9" cy="9" r="6" />
    </Svg>
  );
}

export const GlyphAlert = () => (
  <Svg style={{ color: "var(--danger)" }}>
    <path d="M9 2l8 14H1z M9 7v4 M9 13.5v.5" />
  </Svg>
);
