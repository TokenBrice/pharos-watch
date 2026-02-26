import { Suspense } from "react";
import Image from "next/image";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { HomepageClient } from "@/components/homepage-client";
import { KpiBar } from "@/components/kpi-bar";

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
      <div className="flex items-center gap-3">
        <Image src="/pharos-icon.png" alt="" width={32} height={32} className="rounded-lg" priority />
        <h1 className="text-xl font-mono uppercase tracking-[0.2em] font-semibold">Pharos</h1>
        <span className="text-xs text-muted-foreground/60">
          {total} stablecoins &middot; {PEG_CURRENCY_COUNT} pegs
        </span>
      </div>
      <KpiBar />
      <Suspense fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
        </div>
      }>
        <HomepageClient />
      </Suspense>
    </div>
  );
}
