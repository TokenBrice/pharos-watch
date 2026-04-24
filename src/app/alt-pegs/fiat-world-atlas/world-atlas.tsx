import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import "./peg-hero.css";

function AtlasHeroHeader() {
  return (
    <div className="relative z-10 px-4 py-4 sm:px-5 sm:py-6 lg:px-6">
      <div className="max-w-4xl space-y-2.5 sm:space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-frost-blue/90">Alt-Peg Atlas</p>
        <div className="space-y-2">
          <h2
            id="alt-peg-link-hub"
            className="text-3xl font-black leading-[0.95] tracking-normal text-foreground dark:text-white sm:text-4xl xl:text-5xl"
          >
            Peg Diversity Map
          </h2>
          <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground dark:text-slate-300">
            <span className="sm:hidden">
              Non-USD stablecoins by origin and reference asset, sized by market cap.
            </span>
            <span className="hidden sm:inline">
              Every non-USD stablecoin sits at its geographic origin, sized by market cap, with Gold, Silver, and CPI-linked references floating above the map beyond any single monetary region.
            </span>
          </p>
        </div>
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
