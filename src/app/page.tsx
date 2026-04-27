import type { Metadata } from "next";
import { ACTIVE_STABLECOINS, TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { HomepageStartHereCallout } from "@/components/homepage-sections";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@/lib/urls";
import { logosById } from "@/lib/logos";

export const metadata: Metadata = {
  title: {
    absolute: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOINS.length} Coins | Pharos`,
  },
  description:
    "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: `Stablecoin Analytics Dashboard — Track ${TRACKED_STABLECOINS.length} Coins | Pharos`,
    description:
      "Pharos tracks stablecoins across supported chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
    url: "/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function HomePage() {
  const total = ACTIVE_STABLECOINS.length;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = ACTIVE_STABLECOINS.slice(0, 20).map((coin, i) => {
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
    <div className="space-y-6">
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
      <div className="space-y-5">
        <SiteHeader total={total} pegCount={PEG_CURRENCY_COUNT} chainCount={Object.keys(CHAIN_META).length} />
        <div className="flex flex-col gap-5 lg:contents">
          <div className="order-1 empty:hidden lg:order-2">
            <HomepageStartHereCallout />
          </div>
          <div className="order-2 lg:order-1">
            <KpiBar />
          </div>
        </div>
      </div>
      <HomepageClient />
    </div>
  );
}
