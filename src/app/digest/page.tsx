import type { Metadata } from "next";
import Link from "next/link";
import { Send } from "lucide-react";
import { DigestArchiveClient } from "@/components/digest-archive-client";
import { CalloutBanner } from "@/components/callout-banner";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import digests from "../../../data/digests.json";

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
      <CalloutBanner icon={<Send className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        Get the daily digest straight to your feed.{" "}
        <Link
          href="/telegram#channel"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Join the Pharos Telegram channel&nbsp;&rarr;
        </Link>
      </CalloutBanner>

      <DigestArchiveClient />

      {/* Server-rendered digest links for SEO crawlability (client component loads the interactive list) */}
      <nav aria-label="Digest archive index" className="sr-only">
        {(digests as { date: string; title: string }[]).map((d) => (
          <Link key={d.date} href={`/digest/${d.date}/`}>
            {d.title} — {d.date}
          </Link>
        ))}
      </nav>

      <p className="text-xs text-muted-foreground text-center max-w-2xl mx-auto pt-4">
        Each day Pharos generates a market recap covering peg deviations, supply movements, and emerging trends across
        the stablecoin landscape.
      </p>
    </FeaturePageShell>
  );
}
