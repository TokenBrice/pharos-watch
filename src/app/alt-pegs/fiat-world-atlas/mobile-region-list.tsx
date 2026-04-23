import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { FiatRegionSection } from "@/app/alt-pegs/fiat-world-atlas/region-chips";

const MOBILE_REGION_ORDER: AltPegRegion[] = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"];

export function MobileRegionList({
  fiatItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
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
      {regions.map(({ region, items }) => (
        <FiatRegionSection key={region} region={region} items={items} />
      ))}
    </div>
  );
}
