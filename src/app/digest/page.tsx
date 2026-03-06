import type { Metadata } from "next";
import Link from "next/link";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { FeaturePageShell } from "@/components/feature-page-shell";
import digests from "../../../data/digests.json";

interface DigestIndexEntry {
  date: string;
  title: string;
  generatedAt: number;
}

const digestIndex = (digests as DigestIndexEntry[])
  .slice()
  .sort((a, b) => b.generatedAt - a.generatedAt);

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
    type: "website",
    images: [{ url: "https://pharos.watch/og-digest.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "https://pharos.watch/og-digest.png", width: 1200, height: 628 }],
  },
};

export default function DigestArchivePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Daily Digest Archive"
      path="/digest/"
      title="Daily Digest Archive"
      leadParagraphs={[
        "Every daily stablecoin recap, newest first. Browse historical entries to track major peg events, market-cap shifts, and ecosystem risk transitions over time.",
      ]}
    >

      <DigestArchiveClient />

      {digestIndex.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Digest Directory
          </h2>
          <details className="rounded-lg border border-border/60 bg-muted/20">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              Browse all {digestIndex.length} digest entries
            </summary>
            <ul className="space-y-2 px-4 pb-4">
              {digestIndex.map((digest) => (
                <li key={digest.date}>
                  <Link
                    href={`/digest/${digest.date}/`}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {digest.date}: {digest.title}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto pt-4">
        Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging
        trends across the stablecoin landscape. Also published on the{" "}
        <a href="https://t.me/pharoswatch" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground transition-colors">
          Pharos Telegram channel
        </a>.
      </p>
    </FeaturePageShell>
  );
}
