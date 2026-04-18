import type { Metadata } from "next";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { HomepageStartHereCallout } from "@/components/homepage-sections";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@/lib/urls";

export const metadata: Metadata = {
  title: "Pharos - Stablecoin Analytics Dashboard",
  description:
    "Pharos tracks stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Pharos - Stablecoin Analytics Dashboard",
    description:
      "Pharos tracks stablecoins across major chains with depeg alerts, liquidity scores, on-chain safety signals, dependency risk scoring, and report-card style risk summaries.",
    url: "/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function HomePage() {
  const total = ACTIVE_STABLECOINS.length;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = ACTIVE_STABLECOINS.slice(0, 20).map((coin, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: `${coin.name} (${coin.symbol})`,
    url: `${SITE_URL}${buildStablecoinUrl(coin.id)}`,
  }));
  const itemListCount = itemListElements.length;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Pharos — Stablecoin Analytics Dashboard</h1>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: "Top Tracked Stablecoins",
            description: `${total} stablecoins tracked by Pharos across every major chain.`,
            numberOfItems: itemListCount,
            itemListElement: itemListElements,
          }),
        }}
      />
      <div className="space-y-3">
        <SiteHeader total={total} pegCount={PEG_CURRENCY_COUNT} chainCount={Object.keys(CHAIN_META).length} />
        <div className="flex flex-col gap-3 lg:contents">
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
