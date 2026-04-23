import { buildAltPegLinkHubGroups, type AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { FiatWorldAtlas } from "@/app/alt-pegs/fiat-world-atlas";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();

export function StaticAltPegLinkHub() {
  const fiatItems = LINK_HUB_GROUPS.find((g) => g.label === "Fiat")?.items ?? [];
  const commodityIndexItems: AltPegLinkHubItem[] = LINK_HUB_GROUPS
    .filter((g) => g.label !== "Fiat")
    .flatMap((g) => g.items);

  return (
    <section aria-labelledby="alt-peg-link-hub" className="space-y-3">
      <div className="space-y-1">
        <p className="pharos-kicker">Drill Down</p>
        <h2 id="alt-peg-link-hub" className="pharos-section-title">Explore Peg Cohorts</h2>
        <p className="pharos-meta">
          Static route links keep the non-USD cohort taxonomy crawlable and make
          it easy to jump from the market lens into the peg you want to inspect
          next.
        </p>
      </div>
      <FiatWorldAtlas fiatItems={fiatItems} commodityIndexItems={commodityIndexItems} />
    </section>
  );
}
