import type { Metadata } from "next";
import Link from "next/link";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import digests from "../../../data/digests.json";

interface DigestIndexEntry {
  date: string;
  title: string;
  generatedAt: number;
}

const digestIndex = (digests as DigestIndexEntry[]).slice().sort((a, b) => b.generatedAt - a.generatedAt);
const visibleDigestIndex = digestIndex.slice(0, 12);
const overflowDigestIndex = digestIndex.slice(12);

export const metadata: Metadata = buildPageMetadata({
  title: "Daily Digest Archive: Stablecoin Recaps",
  description:
    "Browse the full Pharos archive of daily stablecoin recaps, from major depegs and supply shifts to slower structural risk changes across the market.",
  canonical: "/digest/",
  ogImage: "https://pharos.watch/og-digest.png",
});

export default function DigestArchivePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Daily Digest Archive"
      path="/digest/"
      title="Daily Digest Archive"
      containerClassName="mx-auto max-w-4xl"
      leadParagraphs={[
        "Every Pharos stablecoin recap, newest first.",
        "The archive exists so major peg events, supply shifts, liquidity changes, and market narratives remain discoverable long after the day they happened.",
      ]}
    >
      <DigestArchiveClient />

      {digestIndex.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Digest Directory</h2>
          <p className="text-sm text-muted-foreground">
            Start with the latest entries below, then expand the full archive when you want older coverage.
          </p>
          <ul className="space-y-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-4">
            {visibleDigestIndex.map((digest) => (
              <li key={digest.date}>
                <Link
                  href={`/digest/${digest.date}/`}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {digest.date}: {digest.title}
                </Link>
              </li>
            ))}
          </ul>
          {overflowDigestIndex.length > 0 && (
            <details className="rounded-lg border border-border/60 bg-muted/20">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Browse the remaining {overflowDigestIndex.length} digest entries
              </summary>
              <ul className="space-y-2 px-4 pb-4">
                {overflowDigestIndex.map((digest) => (
                  <li key={digest.date}>
                    <Link
                      href={`/digest/${digest.date}/`}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {digest.date}: {digest.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto pt-4">
        Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging trends across
        the stablecoin landscape. Also published on the{" "}
        <a
          href="https://t.me/pharoswatch"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground transition-colors"
        >
          Pharos Telegram channel
        </a>
        .
      </p>
    </FeaturePageShell>
  );
}
