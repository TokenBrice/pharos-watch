import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestArchiveClient } from "@/components/digest-archive-client";

export const metadata: Metadata = {
  title: "Daily Digest Archive — Pharos Stablecoin Recaps",
  description:
    "Browse the full archive of Pharos daily stablecoin market recaps — sardonic commentary backed by hard data.",
  alternates: {
    canonical: "/digest/",
  },
  openGraph: {
    title: "Daily Digest Archive — Pharos Stablecoin Recaps",
    description:
      "Browse the full archive of Pharos daily stablecoin market recaps — sardonic commentary backed by hard data.",
    url: "/digest/",
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
        <p className="text-sm text-muted-foreground">
          Every daily recap, newest first.
        </p>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging
          trends across the stablecoin landscape. Browse the full archive to track how conditions have evolved
          over time.
        </p>
      </div>

      <DigestArchiveClient />
    </div>
  );
}
