import type { Metadata } from "next";
import { HomeAltClient } from "@/components/home-alt-client";
import { HomeBlogBanner } from "@/components/home-blog-banner";
import { HomeAltHero } from "@/components/home-alt-hero";
import { HomeMediaStrip } from "@/components/home-media-strip";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCollectionItemListJsonLd, buildStablecoinItemListEntries, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { logosById } from "@/lib/logos";
import { getHomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import {
  CORE_AGGREGATE_STABLECOIN_COUNT,
  HOMEPAGE_TOP_CORE_STABLECOINS,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

const HOMEPAGE_OG_IMAGE = `${SITE_URL}/og-card.png?v=market-pulse-2026-06-28`;
// Build-time reference clock for the hero's static-fallback age gate. The
// statically exported page renders once at build; the client re-evaluates
// expiry with its own clock after hydration (see HomeAltHero).
const HERO_FALLBACK_SELECTED_AT_MS = Date.now();

export const metadata: Metadata = buildPageMetadata({
  title: `Stablecoin Analytics Dashboard: Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
  titleAbsolute: true,
  description:
    "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
  canonical: "/",
  ogImage: HOMEPAGE_OG_IMAGE,
});

export default function HomePage() {
  const total = CORE_AGGREGATE_STABLECOIN_COUNT;
  const heroSnapshot = getHomepageHeroSnapshot();

  // Top 20 stablecoins for ItemList schema
  const itemListEntries = buildStablecoinItemListEntries(HOMEPAGE_TOP_CORE_STABLECOINS, {
    resolveUrl: (coin) => `${SITE_URL}${buildStablecoinUrl(coin.id)}`,
    resolveImage: (coin) => logosById[coin.id] ? `${SITE_URL}${logosById[coin.id]}` : undefined,
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <JsonLdScript
        json={safeJsonLd(
            buildCollectionItemListJsonLd({
              url: SITE_URL,
              collectionId: `${SITE_URL}/#collection`,
              itemListId: `${SITE_URL}/#homepage-itemlist`,
              name: "Pharos - Stablecoin Analytics Dashboard",
              description: `${total} core stablecoins and cash equivalents tracked by Pharos across supported chains.`,
              itemListName: "Top 20 Stablecoins by Market Cap",
              itemListDescription: `Top 20 of ${total} core stablecoins and cash equivalents tracked by Pharos.`,
              entries: itemListEntries,
            }),
          )}
      />
      <HomeBlogBanner />
      <HomeAltHero snapshot={heroSnapshot} fallbackSelectedAtMs={HERO_FALLBACK_SELECTED_AT_MS} />
      <HomeAltClient />
      <HomeMediaStrip />
    </div>
  );
}
