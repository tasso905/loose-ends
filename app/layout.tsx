import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
// Serif is for verbatim source quotes only; don't preload it on every page (sign-in has none).
const plexSerif = IBM_Plex_Serif({ subsets: ["latin"], weight: ["400"], variable: "--font-plex-serif", preload: false });

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
