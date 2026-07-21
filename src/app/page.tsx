import type { Metadata } from "next";
import { HomeAltClient } from "@/components/home-alt-client";
import { HomeBlogBanner } from "@/components/home-blog-banner";
import { HomepageBootstrapScript } from "@/components/homepage-bootstrap-script";
import { HomeAltHero } from "@/components/home-alt-hero";
import { safeJsonLd } from "@/lib/json-ld";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import { getHomepageHeroSnapshot } from "@/lib/homepage-static-snapshot";
import {
  CORE_AGGREGATE_STABLECOIN_COUNT,
  HOMEPAGE_TOP_CORE_STABLECOINS,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

const HOMEPAGE_OG_IMAGE = `${SITE_URL}/og-card.png?v=market-pulse-2026-06-28`;

export const metadata: Metadata = {
  title: {
    absolute: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
  },
  description:
    "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
  alternates: {
    canonical: "/",
  },
  robots: INDEXABLE_ROBOTS,
  openGraph: {
    title: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
    description:
      "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
    url: "/",
    type: "website",
    images: [{ url: HOMEPAGE_OG_IMAGE, width: 1200, height: 628 }],
  },
  twitter: {
    card: "summary_large_image",
    title: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
    description:
      "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
    images: [{ url: HOMEPAGE_OG_IMAGE, width: 1200, height: 628 }],
  },
};

export default function HomePage() {
  const total = CORE_AGGREGATE_STABLECOIN_COUNT;
  const heroSnapshot = getHomepageHeroSnapshot();

  // Top 20 stablecoins for ItemList schema
  const itemListElements = HOMEPAGE_TOP_CORE_STABLECOINS.map((coin, i) => {
    const logo = logosById[coin.id];
    const url = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;

    return {
      "@type": "ListItem" as const,
      position: i + 1,
      item: {
        "@type": "WebPage",
        "@id": url,
        name: `${coin.name} (${coin.symbol})`,
        url,
        ...(logo ? { image: `${SITE_URL}${logo}` } : {}),
      },
    };
  });
  const itemListCount = itemListElements.length;

  return (
    <div className="space-y-5 sm:space-y-6">
      <HomepageBootstrapScript />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd([
            {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/#collection`,
              name: "Pharos - Stablecoin Analytics Dashboard",
              description: `${total} core stablecoins and cash equivalents tracked by Pharos across supported chains.`,
              url: SITE_URL,
              mainEntity: { "@id": `${SITE_URL}/#homepage-itemlist` },
              isPartOf: { "@id": `${SITE_URL}#website` },
            },
            {
              "@context": "https://schema.org",
              "@type": "ItemList",
              "@id": `${SITE_URL}/#homepage-itemlist`,
              name: "Top 20 Stablecoins by Market Cap",
              description: `Top 20 of ${total} core stablecoins and cash equivalents tracked by Pharos.`,
              numberOfItems: itemListCount,
              itemListElement: itemListElements,
            },
          ]),
        }}
      />
      <HomeBlogBanner />
      <HomeAltHero snapshot={heroSnapshot} />
      <HomeAltClient />
    </div>
  );
}
