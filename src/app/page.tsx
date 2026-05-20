import type { Metadata } from "next";
import { CHAIN_META } from "@shared/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { HomepageStartHereCallout } from "@/components/homepage-sections";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";
import {
  ACTIVE_PEG_CURRENCY_COUNT,
  ACTIVE_STABLECOIN_COUNT,
  HOMEPAGE_TOP_ACTIVE_STABLECOINS,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

export const metadata: Metadata = {
  title: {
    absolute: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
  },
  description:
    "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOIN_COUNT} Coins | Pharos`,
    description:
      "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
    url: "/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function HomePage() {
  const total = ACTIVE_STABLECOIN_COUNT;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = HOMEPAGE_TOP_ACTIVE_STABLECOINS.map((coin, i) => {
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
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd([
            {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/#collection`,
              name: "Pharos - Stablecoin Analytics Dashboard",
              description: `${total} active stablecoins tracked by Pharos across supported chains.`,
              url: SITE_URL,
              mainEntity: { "@id": `${SITE_URL}/#homepage-itemlist` },
              isPartOf: { "@id": `${SITE_URL}#website` },
            },
            {
              "@context": "https://schema.org",
              "@type": "ItemList",
              "@id": `${SITE_URL}/#homepage-itemlist`,
              name: "Top 20 Stablecoins by Market Cap",
              description: `Top 20 of ${total} active stablecoins tracked by Pharos.`,
              numberOfItems: itemListCount,
              itemListElement: itemListElements,
            },
          ]),
        }}
      />
      <div className="space-y-4 sm:space-y-5">
        <SiteHeader total={total} pegCount={ACTIVE_PEG_CURRENCY_COUNT} chainCount={Object.keys(CHAIN_META).length} />
        <div className="flex flex-col gap-4 sm:gap-5">
          <div className="empty:hidden">
            <HomepageStartHereCallout />
          </div>
          <div>
            <KpiBar />
          </div>
        </div>
      </div>
      <HomepageClient />
    </div>
  );
}
