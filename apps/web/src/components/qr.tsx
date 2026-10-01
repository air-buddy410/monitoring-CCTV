import { encode } from "uqr";

/** QR code drawn as one SVG path, so no markup is injected and the colors follow the theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const rows = encode(text, { ecc: "M" }).data;
  const n = rows.length;
  let d = "";
  rows.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      viewBox={`-2 -2 ${n + 4} ${n + 4}`}
      role="img"
      aria-label={label}
      className="h-auto w-48 max-w-full"
      shapeRendering="crispEdges"
    >
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="white" />
      <path d={d} fill="black" />
    </svg>
  );
}
