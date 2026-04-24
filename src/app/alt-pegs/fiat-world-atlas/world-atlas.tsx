import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { RegionSummaryPill } from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import "./peg-hero.css";

const ATLAS_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = ["Americas", "Europe", "Asia", "Africa", "Oceania"];

function getRegionCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
}

function regionSlug(region: AltPegRegion): string {
  return region.toLowerCase().replace(/\s+/g, "-");
}

function AtlasMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-l border-border/70 pl-3 first:border-l-0 first:pl-0 dark:border-white/10">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground dark:text-white">{value}</p>
    </div>
  );
}

function AtlasHeroHeader({
  geoRegions,
  totalCohortCount,
  totalCoinCount,
}: {
  geoRegions: readonly {
    region: Exclude<AltPegRegion, "Other">;
    items: readonly AltPegLinkHubItem[];
  }[];
  totalCohortCount: number;
  totalCoinCount: number;
}) {
  return (
    <div className="relative z-10 px-4 py-5 sm:px-5 sm:py-6 lg:px-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.44fr)] lg:items-end">
        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-frost-blue/90">Alt-Peg Atlas</p>
          <div className="space-y-2">
            <h2
              id="alt-peg-link-hub"
              className="text-4xl font-black leading-[0.95] tracking-normal text-foreground dark:text-white xl:text-5xl"
            >
              Peg Diversity Map
            </h2>
            <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground dark:text-slate-300">
              <span className="hidden xl:inline">
                Every non-USD stablecoin sits at its geographic origin, sized by market cap. Gold, Silver, and
                CPI-linked references float in the sky above — references beyond any single monetary region.
              </span>
              <span className="xl:hidden">
                Currency cohorts are grouped by region below; gold, silver, and CPI-linked references appear first.
              </span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-border/70 pt-4 dark:border-white/10 lg:border-t-0 lg:pt-0">
          <AtlasMetric label="Cohorts" value={totalCohortCount} />
          <AtlasMetric label="Coins" value={totalCoinCount} />
          <AtlasMetric label="Regions" value={geoRegions.length} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {geoRegions.map(({ region, items }) => (
          <RegionSummaryPill
            key={region}
            region={region}
            cohortCount={items.length}
            coinCount={getRegionCoinCount(items)}
            href={`#alt-peg-region-${regionSlug(region)}`}
          />
        ))}
      </div>
    </div>
  );
}

export function FiatWorldAtlas({
  fiatItems,
  commodityIndexItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const fiatByRegion = new Map<AltPegRegion, AltPegLinkHubItem[]>();
  for (const item of fiatItems) {
    const list = fiatByRegion.get(item.region) ?? [];
    list.push(item);
    fiatByRegion.set(item.region, list);
  }
  const geoRegions = ATLAS_REGION_ORDER.map((region) => ({
    region,
    items: fiatByRegion.get(region) ?? [],
  })).filter((entry) => entry.items.length > 0);

  const fiatCoinCount = getRegionCoinCount(fiatItems);
  const totalCohortCount = fiatItems.length + commodityIndexItems.length;
  const totalCoinCount = fiatCoinCount + getRegionCoinCount(commodityIndexItems);

  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-border/70 bg-card/92 text-foreground shadow-[0_22px_60px_oklch(0_0_0_/0.12)] dark:border-white/10 dark:bg-[oklch(0.105_0.012_248)] dark:text-white dark:shadow-[0_26px_70px_oklch(0_0_0_/0.22)]"
    >
      <AtlasHeroHeader geoRegions={geoRegions} totalCohortCount={totalCohortCount} totalCoinCount={totalCoinCount} />

      <div data-alt-peg-layout="desktop-atlas" className="hidden xl:block">
        <a
          href="#alt-peg-history-share"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip peg map
        </a>
        <PegDiversityHeroLive worldMap={<WorldMap />} />
      </div>

      <p className="border-t border-border/60 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground dark:border-white/10 dark:text-slate-300/78 sm:px-5 xl:hidden">
        Cohort details continue below the market-cap charts.
      </p>
    </section>
  );
}
