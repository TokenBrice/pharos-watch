import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";
import { FiatRegionSection, LinkChip } from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { MobileRegionList } from "@/app/alt-pegs/fiat-world-atlas/mobile-region-list";

const DIRECTORY_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = ["Americas", "Europe", "Asia", "Africa", "Oceania"];

function getCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
}

function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function BeyondGeographyRail({
  items,
  referenceCoinCount,
}: {
  items: readonly AltPegLinkHubItem[];
  referenceCoinCount: number;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-label="References beyond geography" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90 dark:text-white/90">
          Beyond Geography
        </p>
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground dark:text-slate-300/86">
          {formatCount(items.length, "cohort")} · {formatCount(referenceCoinCount, "coin")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5">
        {items.map((item) => (
          <LinkChip key={item.href} item={item} />
        ))}
      </div>
    </section>
  );
}

export function AltPegCohortDirectory({
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
  const geoRegions = DIRECTORY_REGION_ORDER.map((region) => ({
    region,
    items: fiatByRegion.get(region) ?? [],
  })).filter((entry) => entry.items.length > 0);
  const referenceCoinCount = getCoinCount(commodityIndexItems);

  return (
    <section id="alt-peg-cohort-list" aria-labelledby="alt-peg-cohort-list-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Cohort Details</p>
          <h2 id="alt-peg-cohort-list-heading" className="pharos-section-title">
            Drill Into Each Alt-Peg Cohort
          </h2>
          <p className="pharos-meta">
            Cohorts listed by coin count, grouped by monetary region and references beyond geography.
          </p>
        </div>
      </div>

      <div className="pharos-card-shell overflow-hidden">
        <div className="xl:hidden">
          <CelestialBand items={commodityIndexItems} />
          <MobileRegionList fiatItems={fiatItems} />
        </div>

        <div
          data-alt-peg-layout="desktop-cohort-directory"
          className="hidden gap-3 px-4 py-4 dark:bg-white/[0.035] sm:px-5 sm:py-5 xl:grid xl:grid-cols-3"
        >
          {geoRegions.map(({ region, items }) => (
            <FiatRegionSection key={region} region={region} items={items} />
          ))}
          <BeyondGeographyRail items={commodityIndexItems} referenceCoinCount={referenceCoinCount} />
        </div>
      </div>
    </section>
  );
}
