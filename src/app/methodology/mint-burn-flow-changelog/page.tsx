import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/mint-burn-flow-changelog/",
  metadataTitle: "Mint/Burn Flow Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}. Every scoring and ingestion-policy revision documented.`,
  breadcrumbName: "Mint/Burn Flow Changelog",
  title: "Mint/Burn Flow Changelog",
  lead: (
    <>
      Full version history of Mint/Burn Flow methodology decisions, from v1.0 to {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-orange-500",
  entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  selectImpact: (entry) => entry.methodologyImpact,
});

export const metadata = route.metadata;
export default route.Page;
