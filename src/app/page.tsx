import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { CHAIN_META } from "@/lib/chains";
import { HomepageClient } from "@/components/homepage-client";
import { KpiBar } from "@/components/kpi-bar";
import { SiteHeader } from "@/components/site-header";

export default function HomePage() {
  const total = TRACKED_STABLECOINS.length;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = TRACKED_STABLECOINS.slice(0, 20).map((coin, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: `${coin.name} (${coin.symbol})`,
    url: `https://pharos.watch/stablecoin/${coin.id}/`,
  }));
  const itemListCount = itemListElements.length;

  return (
    <div className="space-y-3 sm:space-y-5">
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
      <SiteHeader total={total} pegCount={PEG_CURRENCY_COUNT} chainCount={Object.keys(CHAIN_META).length} />
      <KpiBar />
      <HomepageClient />
    </div>
  );
}
