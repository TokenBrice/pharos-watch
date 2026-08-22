import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { CalloutBanner } from "@/components/callout-banner";
import { CopyButton } from "@/components/copy-button";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { UpcomingClient } from "@/components/upcoming-client";
import { logosById } from "@/lib/logos";
import aiSummaries from "@data/ai-summaries.json";

// Server-side teaser selection: only the dozen pre-launch texts reach the
// client instead of the full ai-summaries corpus.
const typedSummaries = aiSummaries as Record<string, { text?: string }>;
const PRE_LAUNCH_TEASERS = Object.fromEntries(
  PRE_LAUNCH_STABLECOINS.flatMap((coin) => {
    const text = typedSummaries[coin.id]?.text;
    return text ? [[coin.id, text]] : [];
  }),
);

const PRE_LAUNCH_CLIENT_COINS = PRE_LAUNCH_STABLECOINS.map((coin) => ({
  id: coin.id,
  name: coin.name,
  symbol: coin.symbol,
  flags: {
    pegCurrency: coin.flags.pegCurrency,
    backing: coin.flags.backing,
    governance: coin.flags.governance,
  },
  launchPhase: coin.launchPhase,
  expectedLaunchDate: coin.expectedLaunchDate,
  announcedDate: coin.announcedDate,
  dateHistory: coin.dateHistory,
  milestones: coin.milestones,
}));

const PRE_LAUNCH_LOGOS = Object.fromEntries(
  PRE_LAUNCH_STABLECOINS.map((coin) => [coin.id, logosById[coin.id]]),
);

export const metadata: Metadata = buildPageMetadata({
  title: "Upcoming Stablecoins: Pre-launch Tracker",
  description:
    "Browse upcoming stablecoin launches tracked by Pharos. Filter by launch phase, peg type, and backing. From announced to launching soon.",
  canonical: "/upcoming/",
  ogImage: `${SITE_URL}/og-upcoming.png`,
});

const GLOBAL_LAUNCH_ALERT_COMMAND = "/subscribe launch all";

export default function UpcomingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Upcoming Stablecoins"
      path="/upcoming/"
      title="Upcoming Stablecoins"
      preface={(
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(
              buildCollectionItemListJsonLd({
                url: `${SITE_URL}/upcoming/`,
                name: "Upcoming Stablecoins",
                description: `${PRE_LAUNCH_STABLECOINS.length} pre-launch stablecoins tracked by Pharos.`,
                entries: PRE_LAUNCH_STABLECOINS.map((coin) => {
                  const url = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;

                  return {
                    item: {
                      "@type": "WebPage",
                      "@id": url,
                      name: `${coin.name} (${coin.symbol})`,
                      url,
                    },
                  };
                }),
              }),
            ),
          }}
        />
      )}
      leadParagraphs={[
        "Track upcoming launches before they enter the live stablecoin universe, then open any coin for the full pre-launch dossier.",
      ]}
    >
      <CalloutBanner icon={<Bell className="h-4 w-4" />}>
        Want a launch alert instead of checking back manually? Send{" "}
        <span className="inline-flex items-center gap-1 align-middle">
          <code className="rounded bg-background/70 px-1.5 py-0.5 text-xs font-mono tabular-nums text-foreground">
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

      <UpcomingClient
        coins={PRE_LAUNCH_CLIENT_COINS}
        logos={PRE_LAUNCH_LOGOS}
        teasers={PRE_LAUNCH_TEASERS}
      />

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
