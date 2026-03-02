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
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-foreground">Daily Digest Archive</span>
      </nav>

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
