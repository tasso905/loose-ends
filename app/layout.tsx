import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted IBM Plex (SIL OFL 1.1, licences in app/fonts/): the same latin subset, weights and CSS
// variables next/font/google served, without a font download at build time (which failed builds on
// CI and Vercel). Files are the latin woff2 subsets from @fontsource 5.2 (built from Google Fonts).
const plexSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
  adjustFontFallback: "Arial",
});
// Serif is for verbatim source quotes only; don't preload it on every page (sign-in has none).
const plexSerif = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-latin-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif",
  display: "swap",
  preload: false,
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  // `{Page} · Loose Ends` in the browser tab (SITE_CONTRACT §1.1).
  title: { template: "%s · Loose Ends", default: "Loose Ends" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
