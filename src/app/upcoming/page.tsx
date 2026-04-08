import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { CalloutBanner } from "@/components/callout-banner";
import { CopyButton } from "@/components/copy-button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { UpcomingClient } from "@/components/upcoming-client";

export const metadata: Metadata = buildPageMetadata({
  title: "Upcoming Stablecoins: Pre-Launch Tracker",
  description:
    "Browse upcoming stablecoin launches tracked by Pharos. Filter by launch phase, peg type, and backing. From announced to launching soon.",
  canonical: "/upcoming/",
});

const GLOBAL_LAUNCH_ALERT_COMMAND = "/subscribe launch all";

export default function UpcomingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Upcoming Stablecoins"
      path="/upcoming/"
      title="Upcoming Stablecoins"
      leadParagraphs={[
        "Track upcoming launches before they enter the live stablecoin universe, then open any coin for the full pre-launch dossier.",
      ]}
    >
      <CalloutBanner
        icon={<Bell className="h-4 w-4" />}
        className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      >
        Want a launch alert instead of checking back manually? Send{" "}
        <span className="inline-flex items-center gap-1 align-middle">
          <code className="rounded bg-background/70 px-1.5 py-0.5 text-xs font-mono text-foreground">
            {GLOBAL_LAUNCH_ALERT_COMMAND}
          </code>
          <CopyButton
            text={GLOBAL_LAUNCH_ALERT_COMMAND}
            className="rounded border border-border/60 bg-background/70 text-muted-foreground hover:bg-background hover:text-foreground"
          />
        </span>{" "}
        to{" "}
        <a
          href="https://t.me/PharosWatchBot"
          target="_blank"
          rel="noopener noreferrer"
          className="pharos-focus-ring text-foreground underline underline-offset-4 transition-colors hover:text-foreground/80"
        >
          @PharosWatchBot
        </a>
        , or open any upcoming coin page for a copy-ready exact command tied to that asset.
      </CalloutBanner>

      <UpcomingClient />

      {/* Server-rendered links for SEO crawlability */}
      <nav aria-label="Upcoming stablecoins index" className="sr-only">
        {PRE_LAUNCH_STABLECOINS.map((coin) => (
          <Link key={coin.id} href={buildStablecoinUrl(coin.id)}>
            {coin.name} ({coin.symbol}) — Pre-launch stablecoin
          </Link>
        ))}
      </nav>
    </FeaturePageShell>
  );
}
