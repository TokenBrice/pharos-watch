import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestArchiveClient } from "@/components/digest-archive-client";

export const metadata: Metadata = {
  title: "Daily Digest Archive: Pharos Stablecoin Recaps",
  description:
    "Browse the full archive of Pharos daily stablecoin market recaps. Sardonic commentary backed by hard data.",
  alternates: {
    canonical: "/digest/",
  },
  openGraph: {
    title: "Daily Digest Archive: Pharos Stablecoin Recaps",
    description:
      "Browse the full archive of Pharos daily stablecoin market recaps. Sardonic commentary backed by hard data.",
    url: "/digest/",
    images: [{ url: "https://pharos.watch/og-digest.png", width: 1200, height: 630 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-digest.png", width: 1200, height: 630 }],
  },
};

export default function DigestArchivePage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Daily Digest Archive" path="/digest/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Daily Digest Archive</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Daily Digest Archive</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Every daily stablecoin recap, newest first. Browse historical entries to track major peg events,
          market-cap shifts, and ecosystem risk transitions over time.
        </p>
      </div>

      <DigestArchiveClient />

      <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto pt-4">
        Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging
        trends across the stablecoin landscape. Also published on the{" "}
        <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
          Pharos Telegram channel
        </a>.
      </p>
    </div>
  );
}
