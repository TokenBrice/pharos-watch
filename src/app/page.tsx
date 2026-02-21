import { Suspense } from "react";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { HomepageClient } from "@/components/homepage-client";
import { DailyDigest } from "@/components/daily-digest";

export default function HomePage() {
  const total = TRACKED_STABLECOINS.length;

  // Top 20 stablecoins for ItemList schema
  const itemListElements = TRACKED_STABLECOINS.slice(0, 20).map((coin, i) => ({
    "@type": "ListItem" as const,
    position: i + 1,
    name: `${coin.name} (${coin.symbol})`,
    url: `https://pharos.watch/stablecoin/${coin.id}/`,
  }));

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
            numberOfItems: total,
            itemListElement: itemListElements,
          }),
        }}
      />
      <div className="space-y-2 mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Stablecoin Analytics Dashboard</h1>
        <p className="text-muted-foreground">
          Track {total} stablecoins, across {PEG_CURRENCY_COUNT} pegs. Freezes, liquidity, depegs: all is watched.
        </p>
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
