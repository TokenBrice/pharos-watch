import { buildAltPegLinkHubGroups, type AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { AltPegCohortDirectory } from "@/app/alt-pegs/fiat-world-atlas/cohort-directory";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();

export function StaticAltPegLinkHub() {
  const fiatItems = LINK_HUB_GROUPS.find((g) => g.label === "Fiat")?.items ?? [];
  const commodityIndexItems: AltPegLinkHubItem[] = LINK_HUB_GROUPS
    .filter((g) => g.label !== "Fiat")
    .flatMap((g) => g.items);

  return (
    <div hidden>
      <AltPegCohortDirectory
        fiatItems={fiatItems}
        commodityIndexItems={commodityIndexItems}
        idPrefix="static-alt-peg"
      />
    </div>
  );
}
