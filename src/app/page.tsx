import { Suspense } from "react";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { HomepageClient } from "@/components/homepage-client";
import { DailyDigest } from "@/components/daily-digest";
import { StabilityIndex } from "@/components/stability-index";

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
    <>
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
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Shining a Light on Every Peg</h1>
          <p className="text-muted-foreground">
            Track {total} stablecoins, across {PEG_CURRENCY_COUNT} pegs. Freezes, liquidity, depegs: all is watched.
          </p>
        </div>
        <StabilityIndex />
      </div>
      <div className="mb-6">
        <DailyDigest />
      </div>
      <Suspense fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
        </div>
      }>
        <HomepageClient />
      </Suspense>
    </>
  );
}
