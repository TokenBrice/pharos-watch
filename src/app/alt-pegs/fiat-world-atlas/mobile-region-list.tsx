import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { FiatRegionSection } from "@/app/alt-pegs/fiat-world-atlas/region-chips";

const MOBILE_REGION_ORDER: AltPegRegion[] = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"];

export function MobileRegionList({
  fiatItems,
  idPrefix,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  idPrefix?: string;
}) {
  const byRegion = new Map<AltPegRegion, AltPegLinkHubItem[]>();
  for (const item of fiatItems) {
    const list = byRegion.get(item.region) ?? [];
    list.push(item);
    byRegion.set(item.region, list);
  }
  const regions = MOBILE_REGION_ORDER.map((region) => ({
    region,
    items: byRegion.get(region) ?? [],
  })).filter((entry) => entry.items.length > 0);

  return (
    <div data-alt-peg-layout="region-list" className="space-y-4 px-4 py-4 sm:px-5 sm:py-5 xl:hidden">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground dark:text-slate-300/78">
        Cohorts listed by coin count.
      </p>
      {regions.map(({ region, items }) => (
        <FiatRegionSection key={region} region={region} items={items} idPrefix={idPrefix} />
      ))}
    </div>
  );
}
