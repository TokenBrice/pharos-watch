import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { FiatRegionSection, LinkChip } from "@/app/alt-pegs/fiat-world-atlas/region-chips";

const MOBILE_REGION_ORDER: AltPegRegion[] = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"];

export function MobileRegionList({
  fiatItems,
  commodityIndexItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
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
      {commodityIndexItems.length > 0 ? (
        <section
          aria-labelledby="alt-peg-mobile-commodity"
          className="space-y-2"
          data-region="Non-geographic"
        >
          <h4
            id="alt-peg-mobile-commodity"
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90"
          >
            References beyond geography
          </h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {commodityIndexItems.map((item) => (
              <LinkChip key={item.peg} item={item} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
