import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";
import { FiatRegionSection, LinkChip, RegionSummaryPill } from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { WorldMapInteractive, type CountryInfo } from "@/app/alt-pegs/fiat-world-atlas/world-map-interactive";
import { MobileRegionList } from "@/app/alt-pegs/fiat-world-atlas/mobile-region-list";
import { MapEmblemClusters } from "@/app/alt-pegs/fiat-world-atlas/map-emblem-clusters";
import { MapDeadspotReferences } from "@/app/alt-pegs/fiat-world-atlas/map-deadspot-references";
import { PEG_COUNTRY_MAP } from "@/lib/alt-peg-geography";
import { buildPegEmblemClusters } from "@/lib/alt-peg-emblems";

const ATLAS_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = ["Americas", "Europe", "Asia", "Africa", "Oceania"];

function getRegionCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
}

function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function AtlasMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-l border-white/10 pl-3 first:border-l-0 first:pl-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-white">{value}</p>
    </div>
  );
}

function AtlasHeroHeader({
  geoRegions,
  totalCohortCount,
  totalCoinCount,
}: {
  geoRegions: readonly { region: Exclude<AltPegRegion, "Other">; items: readonly AltPegLinkHubItem[] }[];
  totalCohortCount: number;
  totalCoinCount: number;
}) {
  return (
    <div className="relative z-10 px-4 py-5 sm:px-5 sm:py-6 lg:px-6">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.44fr)] lg:items-end">
        <div className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-frost-blue/90">Fiat Peg Geography</p>
          <div className="space-y-2">
            <h2
              id="alt-peg-link-hub"
              className="text-4xl font-black leading-[0.95] tracking-normal text-white sm:text-5xl"
            >
              Peg Diversity Map
            </h2>
            <p className="max-w-4xl text-sm leading-relaxed text-slate-300">
              Static cohort links stay crawlable while the map shows how non-USD references spread across fiat regions,
              commodities, and index-linked pegs. Gold, Silver, and index-linked cohorts float over ocean deadspots
              because those references sit beyond any single monetary region.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t border-white/10 pt-4 lg:border-t-0 lg:pt-0">
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
          />
        ))}
      </div>
    </div>
  );
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
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90">Beyond Geography</p>
        <p className="font-mono text-[11px] tabular-nums text-slate-300/86">
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

  const countryInfo: Record<string, CountryInfo> = {};
  for (const item of fiatItems) {
    const countries = PEG_COUNTRY_MAP[item.peg];
    if (!countries) continue;
    const info: CountryInfo = {
      peg: item.peg,
      label: item.label,
      coinCount: item.coinCount,
      symbolPreview: item.symbolPreview,
    };
    for (const iso of countries) countryInfo[iso] = info;
  }
  const fiatCoinCount = getRegionCoinCount(fiatItems);
  const referenceCoinCount = getRegionCoinCount(commodityIndexItems);
  const totalCohortCount = fiatItems.length + commodityIndexItems.length;
  const totalCoinCount = fiatCoinCount + referenceCoinCount;

  return (
    <section
      aria-labelledby="alt-peg-link-hub"
      className="relative overflow-hidden rounded-[1.45rem] border border-slate-950/15 bg-[oklch(0.105_0.012_248)] text-white shadow-[0_26px_70px_oklch(0_0_0_/0.22)] dark:border-white/10"
    >
      <AtlasHeroHeader geoRegions={geoRegions} totalCohortCount={totalCohortCount} totalCoinCount={totalCoinCount} />

      <div data-alt-peg-layout="desktop-atlas" className="hidden xl:block">
        <div className="relative border-y border-white/10 bg-[oklch(0.08_0.01_248)]">
          <WorldMapInteractive countryInfo={countryInfo}>
            <WorldMap items={fiatItems} />
          </WorldMapInteractive>
          <MapEmblemClusters clusters={buildPegEmblemClusters()} />
          <MapDeadspotReferences items={commodityIndexItems} />
        </div>
        <div className="grid gap-3 bg-white/[0.035] px-4 py-4 sm:grid-cols-2 sm:px-5 sm:py-5 lg:grid-cols-3">
          {geoRegions.map(({ region, items }) => (
            <FiatRegionSection key={region} region={region} items={items} />
          ))}
          <BeyondGeographyRail items={commodityIndexItems} referenceCoinCount={referenceCoinCount} />
        </div>
      </div>

      <div className="xl:hidden">
        <CelestialBand items={commodityIndexItems} />
        <MobileRegionList fiatItems={fiatItems} />
      </div>
    </section>
  );
}
