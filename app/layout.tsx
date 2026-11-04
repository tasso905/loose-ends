import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted IBM Plex (SIL OFL 1.1, licences in app/fonts/): the same subsets, weights and CSS
// variables next/font/google served (latin, latin-ext, Cyrillic, Cyrillic-ext, Greek, Vietnamese),
// without a font download at build time (which failed builds on CI and Vercel). Files are the woff2
// subsets of @fontsource/ibm-plex-sans 5.2.8 and @fontsource/ibm-plex-serif 5.2.7 (built from Google
// Fonts); the unicode-range values are copied from their CSS. IBM Plex Serif has no Greek subset.
//
// next/font/local applies `declarations` to every file of one call, so each subset is its own call
// with its own unicode-range, and so its own family name, exposed as one CSS variable per subset
// (--font-plex-sans-latin, --font-plex-sans-greek, ...). app/globals.css composes --font-plex-sans
// and --font-plex-serif from them in a :root rule: the subset families in order, then the
// size-adjusted fallback face declared there. The browser takes each character from the first
// family whose unicode-range covers it, and downloads a subset file only when a page uses a
// character in its range. No inline style attribute, so a strict CSP `style-src 'self'` still
// gets every subset. Only latin Sans is preloaded (as
// before); the other subsets cost nothing on first load. next/font loader arguments must be
// literals, so the calls are written out.

const plexSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-latin",
  display: "swap",
  // The size-adjusted Arial fallback is declared in app/globals.css so it can come after every subset.
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
});
const plexSansLatinExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-ext-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
});
const plexSansCyrillic = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-cyrillic-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
});
const plexSansCyrillicExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
});
const plexSansGreek = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-greek-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-greek-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-greek-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-greek",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF" },
  ],
});
const plexSansVietnamese = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-vietnamese-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-vietnamese-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-vietnamese-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-sans-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
});

// Serif is for verbatim source quotes only; don't preload it on every page (sign-in has none).
const plexSerif = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-latin-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif-latin",
  display: "swap",
  preload: false,
  // The size-adjusted Times New Roman fallback is declared in app/globals.css (see Sans).
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
});
const plexSerifLatinExt = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-latin-ext-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif-latin-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
});
const plexSerifCyrillic = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-cyrillic-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif-cyrillic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
});
const plexSerifCyrillicExt = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-cyrillic-ext-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif-cyrillic-ext",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
});
const plexSerifVietnamese = localFont({
  src: [{ path: "./fonts/ibm-plex-serif-vietnamese-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-plex-serif-vietnamese",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
});

// Every call's class goes on <html> so its @font-face rules are always in the page CSS and its
// family variable is defined where globals.css's :root rule reads it.
const fontClasses = [
  plexSans,
  plexSansLatinExt,
  plexSansCyrillic,
  plexSansCyrillicExt,
  plexSansGreek,
  plexSansVietnamese,
  plexSerif,
  plexSerifLatinExt,
  plexSerifCyrillic,
  plexSerifCyrillicExt,
  plexSerifVietnamese,
]
  .map((f) => f.variable)
  .join(" ");

export const metadata: Metadata = {
  // `{Page} · Loose Ends` in the browser tab (SITE_CONTRACT §1.1).
  title: { template: "%s · Loose Ends", default: "Loose Ends" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontClasses}>
      <body>{children}</body>
    </html>
  );
}
