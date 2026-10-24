import type { Metadata } from "next";
import { HomeAltClient } from "@/components/home-alt-client";
import { HomeBlogBanner } from "@/components/home-blog-banner";
import { HomeAltHero } from "@/components/home-alt-hero";
import { HomeMediaStrip } from "@/components/home-media-strip";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCollectionItemListJsonLd, buildStablecoinItemListEntries, safeJsonLd } from "@/lib/json-ld";
import { buildLiveRouteOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { getLogoSrc, logosById } from "@/lib/logos";
import { getHomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import { getHomepageDataBootstrapScript } from "@/lib/data-bootstrap-script";
import { HomepageEvidenceProvider } from "@/lib/homepage-evidence";
import {
  CORE_AGGREGATE_STABLECOIN_COUNT,
  DEAD_STABLECOIN_COUNT,
  HOMEPAGE_TOP_CORE_STABLECOINS,
} from "@/lib/stablecoin-static-data";
import { HEADLINE_STABLECOIN_COUNT, HEADLINE_STABLECOIN_LABEL } from "@/lib/universe-vocabulary";

// Build-time reference clock for the hero's static-fallback age gate. The
// statically exported page renders once at build; the client re-evaluates
// expiry with its own clock after hydration (see HomeAltHero).
const HERO_FALLBACK_SELECTED_AT_MS = Date.now();

export const metadata: Metadata = buildPageMetadata({
  title: `Stablecoin Analytics: Track ${HEADLINE_STABLECOIN_COUNT} Active Stablecoins | Pharos`,
  titleAbsolute: true,
  description: `Live peg, Safety Score, liquidity and freeze data for ${HEADLINE_STABLECOIN_COUNT} ${HEADLINE_STABLECOIN_LABEL}, with depeg alerts, reserve evidence and a record of ${DEAD_STABLECOIN_COUNT} failed coins.`,
  canonical: "/",
  ogImage: buildLiveRouteOgImageUrl("home"),
});

export default async function HomePage() {
  const total = CORE_AGGREGATE_STABLECOIN_COUNT;
  const heroSnapshot = await getHomepageHeroSnapshot();

  // Top 20 stablecoins for ItemList schema
  const itemListEntries = buildStablecoinItemListEntries(HOMEPAGE_TOP_CORE_STABLECOINS, {
    resolveUrl: (coin) => `${SITE_URL}${buildStablecoinUrl(coin.id)}`,
    resolveImage: (coin) => {
      const logoSrc = getLogoSrc(logosById, coin.id);
      return logoSrc ? `${SITE_URL}${logoSrc}` : undefined;
    },
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <script
        id="pharos-home-data-bootstrap"
        dangerouslySetInnerHTML={{ __html: getHomepageDataBootstrapScript() }}
      />
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
      <HomepageEvidenceProvider>
        <HomeAltHero snapshot={heroSnapshot} fallbackSelectedAtMs={HERO_FALLBACK_SELECTED_AT_MS} />
      </HomepageEvidenceProvider>
      <HomeBlogBanner />
      <HomeAltClient>
        <HomeMediaStrip />
      </HomeAltClient>
    </div>
  );
}
