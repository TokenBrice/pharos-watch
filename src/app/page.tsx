import type { Metadata } from "next";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";
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
  const total = TRACKED_STABLECOINS.length;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = TRACKED_STABLECOINS.slice(0, 20).map((coin, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: `${coin.name} (${coin.symbol})`,
    url: `https://pharos.watch${buildStablecoinUrl(coin.id)}`,
  }));
  const itemListCount = itemListElements.length;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Pharos — Stablecoin Analytics Dashboard</h1>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
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
        <KpiBar />
      </div>
      <HomepageClient />
    </div>
  );
}
