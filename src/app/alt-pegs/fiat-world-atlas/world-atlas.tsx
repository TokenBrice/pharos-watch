import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import "./peg-hero.css";

function AtlasHeroHeader() {
  return (
    <div className="relative z-10 px-4 pt-4 pb-3 sm:px-5 sm:pt-5 sm:pb-4 lg:px-6">
      <div className="flex max-w-4xl flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-frost-blue/90">Alt-Peg Atlas</p>
        <h2
          id="alt-peg-link-hub"
          className="text-base font-semibold tracking-tight text-foreground/85 dark:text-white/80"
        >
          Peg Diversity Map
        </h2>
      </div>
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
