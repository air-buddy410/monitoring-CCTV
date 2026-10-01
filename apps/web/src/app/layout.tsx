import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-next/800.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PANTAU", template: "%s | PANTAU" },
  description: "Tambah perangkat ONVIF, baca hasil probe, dan ambil snapshot kameranya.",
};

const demo = process.env.NEXT_PUBLIC_DEMO === "1";

// Applies a saved light/dark choice before first paint; without one the OS preference decides in CSS.
const themeInit = `try{var t=localStorage.getItem("pantau-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {demo ? (
          <div role="note" className="bg-accent px-3 py-2 text-on-accent">
            <strong>Mode Simulasi.</strong> Perangkat dan gambar di sini berasal dari mock ONVIF lokal, bukan
            dari CCTV nyata.
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
