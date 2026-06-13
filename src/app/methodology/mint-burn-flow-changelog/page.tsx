import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG_PATH,
  metadataTitle: "Mint/Burn Flow Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}. Every scoring and ingestion-policy revision documented.`,
  breadcrumbName: "Mint/Burn Flow Changelog",
  title: "Mint/Burn Flow Changelog",
  leadSubject: "Mint/Burn Flow",
  versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  entries: MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  citation: { id: "mint-burn-flow", versionLabel: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
