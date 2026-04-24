import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import "./peg-hero.css";

function AtlasHeroHeader() {
  return (
    <div className="relative z-10 px-4 pt-4 pb-3 sm:px-5 sm:pt-5 sm:pb-4 lg:px-6">
      <h2
        id="alt-peg-link-hub"
        className="text-lg font-semibold tracking-tight text-frost-blue/95 sm:text-xl lg:text-[1.45rem]"
      >
        Peg Diversity Atlas
      </h2>
    </div>
  );
}

export function FiatWorldAtlas(_props: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-border/70 bg-card/92 text-foreground shadow-[0_22px_60px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[oklch(0.105_0.012_248)] dark:text-white dark:shadow-[0_26px_70px_oklch(0_0_0_/0.22)]"
    >
      <AtlasHeroHeader />

      <div data-alt-peg-layout="responsive-atlas" className="block">
        <a
          href="#alt-peg-history-share"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip peg map
        </a>
        <div className="peg-hero__viewport" role="group" aria-label="Peg diversity map atlas">
          <PegDiversityHeroLive worldMap={<WorldMap />} />
        </div>
      </div>
    </section>
  );
}
