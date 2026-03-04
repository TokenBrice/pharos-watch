import type { Metadata } from "next";
import { MethodologyChangelogPage } from "@/components/methodology-changelog-page";
import {
  MINT_BURN_FLOW_METHODOLOGY_CHANGELOG,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
} from "@/lib/mint-burn-flow-version";

export const metadata: Metadata = {
  title: "Mint/Burn Flow Changelog - Version History",
  description:
    `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}. Every scoring and ingestion-policy revision documented.`,
  alternates: { canonical: "/methodology/mint-burn-flow-changelog/" },
  openGraph: {
    title: "Mint/Burn Flow Changelog - Version History",
    description:
      `Full version history of the Pharos Mint/Burn Flow methodology, from v1.0 through ${MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL}.`,
    url: "/methodology/mint-burn-flow-changelog/",
  },
};

const entries = MINT_BURN_FLOW_METHODOLOGY_CHANGELOG.map((entry) => ({
  version: entry.version,
  title: entry.title,
  date: entry.date,
  summary: entry.summary,
  impact: entry.methodologyImpact,
  commits: entry.commits,
  reconstructed: entry.reconstructed,
}));

export default function MintBurnFlowChangelogPage() {
  return (
    <MethodologyChangelogPage
      breadcrumbName="Mint/Burn Flow Changelog"
      path="/methodology/mint-burn-flow-changelog/"
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
