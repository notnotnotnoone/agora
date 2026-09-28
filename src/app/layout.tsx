import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Geist, bundled the same way flexrouter's dashboard ships it.
const geist = localFont({ src: "./fonts/Geist.woff2", variable: "--font-geist", display: "swap" });
const geistMono = localFont({ src: "./fonts/GeistMono.woff2", variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Agora · a flexrouter showcase",
  description:
    "Ask a moral dilemma to every free-tier model you have at once, routed through flexrouter, and watch the consensus form.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
