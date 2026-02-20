import { Suspense } from "react";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";
import { HomepageTestClient } from "@/components/homepage-test-client";
import { CollapsibleIntro } from "@/components/collapsible-intro";

export default function HomeTestPage() {
  const total = TRACKED_STABLECOINS.length;
  const decentralized = TRACKED_STABLECOINS.filter(
    (s) => s.flags.governance === "decentralized"
  ).length;
  const cefiDep = TRACKED_STABLECOINS.filter(
    (s) => s.flags.governance === "centralized-dependent"
  ).length;
  const centralized = TRACKED_STABLECOINS.filter(
    (s) => s.flags.governance === "centralized"
  ).length;

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
      <CollapsibleIntro
        title="Stablecoin Analytics Dashboard"
        subtitle={`Tracking ${total} stablecoins. Every chain. Every freeze.`}
      >
        <p className="text-sm text-muted-foreground">
          Pharos tracks {total} stablecoins across {PEG_CURRENCY_COUNT} peg currencies — USD, EUR, GBP,
          gold, silver, and more — with honest governance classification: {centralized} CeFi,
          {" "}{cefiDep} CeFi-Dependent, and {decentralized} DeFi. Live market caps, peg
          deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of
          fallen stablecoins — updated every 5 minutes.
        </p>
      </CollapsibleIntro>
      <Suspense fallback={
        <div className="flex min-h-[40vh] items-center justify-center">
          <div className="h-10 w-10 rounded-full bg-frost-blue/30 animate-pharos-pulse" />
        </div>
      }>
        <HomepageTestClient />
      </Suspense>
    </>
  );
}
