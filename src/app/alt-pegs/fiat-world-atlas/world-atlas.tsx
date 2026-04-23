import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";
import {
  FiatRegionSection,
  RegionSummaryPill,
} from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { MobileRegionList } from "@/app/alt-pegs/fiat-world-atlas/mobile-region-list";

const ATLAS_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = [
  "Americas",
  "Europe",
  "Asia",
  "Africa",
  "Oceania",
];

function getRegionCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
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

  return (
    <section aria-labelledby="alt-peg-fiat-geography" className="pharos-card-shell overflow-hidden">
      <div className="space-y-3 px-4 py-4 sm:px-5 sm:py-5">
        <div className="space-y-1">
          <h3 id="alt-peg-fiat-geography" className="pharos-kicker">
            Fiat Peg Geography
          </h3>
          <p className="text-sm text-muted-foreground">
            Countries are colored by the fiat peg whose currency they reference.
            Gold, Silver, and index-linked cohorts float above the map as
            references that exist beyond any single monetary region.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {geoRegions.map(({ region, items }) => (
            <RegionSummaryPill
              key={region}
              region={region}
              cohortCount={items.length}
              coinCount={getRegionCoinCount(items)}
            />
          ))}
        </div>
      </div>

      <CelestialBand items={commodityIndexItems} />

      <div
        data-alt-peg-layout="desktop-atlas"
        className="hidden xl:block"
      >
        <div className="relative bg-[oklch(0.14_0.01_248)]">
          <WorldMap items={fiatItems} />
        </div>
        <div className="grid gap-3 px-4 py-4 sm:px-5 sm:py-5 sm:grid-cols-2 lg:grid-cols-3">
          {geoRegions.map(({ region, items }) => (
            <FiatRegionSection key={region} region={region} items={items} />
          ))}
        </div>
      </div>

      <MobileRegionList fiatItems={fiatItems} />
    </section>
  );
}
