// Renders the "Simulasi" demo frames served by the mock ONVIF device. Original abstract scenes drawn
// here, no people and no third-party assets. Run: pnpm --filter @pantau/web demo:frames
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/mock-onvif/fixtures");
mkdirSync(out, { recursive: true });

const W = 1280;
const H = 720;

function scene({ label, hue, rack, door, shelves }) {
  const wall = `hsl(${hue} 14% 24%)`;
  const wallDark = `hsl(${hue} 16% 17%)`;
  const floor = `hsl(${hue} 10% 30%)`;
  const ceil = `hsl(${hue} 12% 20%)`;
  const lines = Array.from({ length: 9 }, (_, i) => {
    const x = 240 + i * 100;
    return `<line x1="${x}" y1="440" x2="${(x - 640) * 2.1 + 640}" y2="${H}" stroke="hsl(${hue} 8% 38%)" stroke-width="1.5"/>`;
  }).join("");
  const rows = [470, 505, 548, 600, 665]
    .map((y) => `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="hsl(${hue} 8% 36%)" stroke-width="1.2"/>`)
    .join("");
  const rackLeds = Array.from({ length: 14 }, (_, i) => {
    const y = 190 + i * 18;
    const on = (i * 7 + rack) % 3 !== 0;
    return `<rect x="${rack === 1 ? 830 : 500}" y="${y}" width="70" height="12" fill="hsl(${hue} 10% 12%)"/><rect x="${(rack === 1 ? 830 : 500) + 56}" y="${y + 4}" width="6" height="4" fill="${on ? "#58e08a" : "#3a4a40"}"/>`;
  }).join("");
  const shelf = Array.from(
    { length: shelves },
    (_, i) =>
      `<rect x="${380 + i * 74}" y="${300 + (i % 2) * 16}" width="56" height="${70 - (i % 2) * 16}" fill="hsl(${hue} 14% 31%)" stroke="hsl(${hue} 10% 14%)" stroke-width="2"/>`,
  ).join("");
  return `<!doctype html><html><body style="margin:0;background:#000"><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
 <radialGradient id="v" cx="50%" cy="50%" r="70%"><stop offset="55%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.62"/></radialGradient>
 <linearGradient id="lt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${hue}"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.09 0"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="${wallDark}"/>
<polygon points="0,0 ${W},0 920,140 360,140" fill="${ceil}"/>
<polygon points="0,0 360,140 360,440 0,${H}" fill="${wallDark}"/>
<polygon points="${W},0 920,140 920,440 ${W},${H}" fill="${wallDark}"/>
<rect x="360" y="140" width="560" height="300" fill="${wall}"/>
<polygon points="0,${H} 360,440 920,440 ${W},${H}" fill="${floor}"/>
${lines}${rows}
<rect x="410" y="148" width="120" height="14" fill="#fff" opacity="0.8"/><rect x="750" y="148" width="120" height="14" fill="#fff" opacity="0.8"/>
<polygon points="410,162 530,162 600,440 340,440" fill="url(#lt)" opacity="0.5"/>
<polygon points="750,162 870,162 940,440 680,440" fill="url(#lt)" opacity="0.4"/>
${door ? `<rect x="610" y="236" width="86" height="204" fill="hsl(${hue} 14% 16%)" stroke="hsl(${hue} 12% 38%)" stroke-width="3"/><rect x="676" y="340" width="8" height="26" fill="#c9b27a"/>` : ""}
${shelf}
<rect x="${rack === 1 ? 820 : 490}" y="180" width="90" height="270" fill="hsl(${hue} 12% 15%)" stroke="hsl(${hue} 10% 38%)" stroke-width="3"/>
${rackLeds}
<rect x="540" y="400" width="250" height="14" fill="hsl(${hue} 12% 38%)"/><rect x="552" y="414" width="12" height="40" fill="hsl(${hue} 12% 28%)"/><rect x="766" y="414" width="12" height="40" fill="hsl(${hue} 12% 28%)"/>
<rect width="${W}" height="${H}" filter="url(#n)"/>
<rect width="${W}" height="${H}" fill="url(#v)"/>
<rect x="24" y="22" width="258" height="54" fill="#000" opacity="0.72"/>
<text x="38" y="48" font-family="monospace" font-weight="700" font-size="22" fill="#f2b13c">SIMULASI</text>
<text x="38" y="68" font-family="monospace" font-size="15" fill="#efeadf">${label}</text>
<rect x="${W - 396}" y="${H - 58}" width="372" height="34" fill="#000" opacity="0.72"/>
<text x="${W - 382}" y="${H - 35}" font-family="monospace" font-size="15" fill="#efeadf">FIXTURE LAB, BUKAN CCTV NYATA</text>
</svg></body></html>`;
}

const frames = [
  { file: "frame-1.jpg", label: "KANAL 1 / RUANG LAB A", hue: 192, rack: 1, door: true, shelves: 3 },
  { file: "frame-2.jpg", label: "KANAL 2 / RUANG LAB A", hue: 36, rack: 2, door: false, shelves: 5 },
  { file: "frame-3.jpg", label: "KAMERA TUNGGAL / LAB B", hue: 150, rack: 1, door: true, shelves: 2 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
for (const f of frames) {
  await page.setContent(scene(f));
  const buf = await page.screenshot({ type: "jpeg", quality: 78 });
  writeFileSync(resolve(out, f.file), buf);
  console.log(f.file, buf.length, "bytes");
}
await browser.close();
