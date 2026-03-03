import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { CHAIN_META } from "@/lib/chains";
import { ACTIVE_PEGS, PEG_LABELS_SHORT, PEG_SLUGS, pegCoinCount } from "@/lib/peg-landing";
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
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Browse By Peg
        </h2>
        <div className="flex flex-wrap gap-2">
          {ACTIVE_PEGS.map((peg) => {
            const slug = PEG_SLUGS[peg];
            if (!slug) return null;
            return (
              <Link
                key={peg}
                href={`/stablecoins/${slug}/`}
                className="inline-flex items-center rounded-full border px-3 py-1.5 sm:py-1 min-h-11 sm:min-h-0 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {PEG_LABELS_SHORT[peg]} ({pegCoinCount(peg)})
              </Link>
            );
          })}
        </div>
      </section>
      <HomepageClient />
    </div>
  );
}
