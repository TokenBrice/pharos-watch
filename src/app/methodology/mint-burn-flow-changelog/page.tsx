import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/mint-burn-flow-version";
import {
  buildMethodologyChangelogMetadata,
  mapMethodologyChangelogEntries,
} from "../changelog-page-utils";

const PAGE_PATH = "/methodology/mint-burn-flow-changelog/";

export const metadata = buildMethodologyChangelogMetadata({
  title: "Mint/Burn Flow Changelog - Version History",
  description:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}. Every scoring and ingestion-policy revision documented.`,
  path: PAGE_PATH,
});

const entries = mapMethodologyChangelogEntries(
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  (entry) => entry.methodologyImpact,
);

export default function MintBurnFlowChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Mint/Burn Flow Changelog"
      path={PAGE_PATH}
      title="Mint/Burn Flow Changelog"
      lead={
        <>
          Full version history of Mint/Burn Flow methodology decisions, from v1.0 to {MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.
        </>
      }
      accentClass="border-l-orange-500"
      entries={entries}
    />
  );
}
