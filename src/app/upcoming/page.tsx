import type { Metadata } from "next";
import Link from "next/link";
import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ShareButton } from "@/components/share-button";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { UpcomingClient } from "@/components/upcoming-client";
import { getLogoSrc, logosById } from "@/lib/logos";
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
  PRE_LAUNCH_STABLECOINS.map((coin) => [coin.id, getLogoSrc(logosById, coin.id)]),
);

export const metadata: Metadata = buildPageMetadata({
  title: "Upcoming Stablecoins: Pre-launch Tracker",
  description:
    "Browse upcoming stablecoin launches tracked by Pharos. Filter by launch phase, peg type, and backing. From announced to launching soon.",
  canonical: "/upcoming/",
  ogImage: `${SITE_URL}/og-upcoming.png`,
});

export default function UpcomingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Upcoming Stablecoins"
      path="/upcoming/"
      title="Upcoming Stablecoins"
      header="instrument"
      headerActions={(
        <>
          <AlertsHeaderLink
            href="/pharoswatchbot/#getting-started"
            description="Get a Telegram alert when a tracked stablecoin launches: send /subscribe launch all to @PharosWatchBot"
          />
          {/* Timeless by decision (docs/og-images.md): the route card carries no registry count. */}
          <ShareButton ogPath={API_PATHS.ogPage("upcoming")} />
        </>
      )}
      leadDisclosureLabel="How to use the tracker"
      preface={(
        <JsonLdScript
          json={safeJsonLd(
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
            )}
        />
      )}
      leadParagraphs={[
        "Pre-launch stablecoins Pharos tracks, by phase, target date and slippage.",
        "Coins move to the live universe when they launch. Open any coin for its pre-launch dossier: sourced milestones, target history, and a copy-ready alert command for that asset.",
      ]}
    >
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
