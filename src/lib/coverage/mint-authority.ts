import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createBreakdownCounter,
  createPresetStatus,
  defineCoverageFeature,
  type CoverageLegendItem,
} from "./shared";
import {
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_SCORE_FILTER_VALUES,
  MINT_AUTHORITY_STATUS_CONFIG,
  MINT_AUTHORITY_STATUS_VALUES,
  resolveMintAuthorityScoreDisplay,
  resolveMintAuthorityStatus,
  type MintAuthorityStatusKind,
} from "@/lib/mint-authority-display";

function resolveMintAuthority(summary?: MintAuthorityCoverageSummary | null): CoverageStatus {
  const status = resolveMintAuthorityStatus(summary);
  const score = resolveMintAuthorityScoreDisplay(undefined, summary);
  return {
    ...createPresetStatus(status),
    score: score.result.score,
    scoreBand: score.bandKey,
  };
}

function formatMintAuthority(
  rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  const scoreBandCount = (band: string) =>
    rows.filter((row) => row.statuses.mintAuthority.scoreBand === band).length;
  return [
    breakdownItem("no-privileged-mint", "no privileged", get("no-privileged-mint")),
    breakdownItem("governed-mint", "governed", get("governed-mint")),
    breakdownItem("multisig-mint", "multisig", get("multisig-mint")),
    breakdownItem("issuer-or-backend-mint", "issuer/backend", get("issuer-or-backend-mint")),
    breakdownItem("bridge-mint", "bridge", get("bridge-mint")),
    breakdownItem("inherited-authority", "inherited", get("inherited-authority")),
    breakdownItem("unknown", "unknown", get("unknown")),
    ...MINT_AUTHORITY_SCORE_FILTER_VALUES.map((band) =>
      breakdownItem(`score-${band}`, MINT_AUTHORITY_SCORE_FILTER_CONFIG[band].label, scoreBandCount(band)),
    ),
  ];
}

const MINT_AUTHORITY_KINDS: readonly MintAuthorityStatusKind[] = MINT_AUTHORITY_STATUS_VALUES;

const MINT_AUTHORITY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "No priv.",
    description:
      MINT_AUTHORITY_STATUS_CONFIG["no-privileged-mint"].detail,
    kinds: ["no-privileged-mint"],
  },
  {
    term: "Governed",
    description: MINT_AUTHORITY_STATUS_CONFIG["governed-mint"].detail,
    kinds: ["governed-mint"],
  },
  {
    term: "Multisig",
    description: MINT_AUTHORITY_STATUS_CONFIG["multisig-mint"].detail,
    kinds: ["multisig-mint"],
  },
  {
    term: "Issuer",
    description: MINT_AUTHORITY_STATUS_CONFIG["issuer-or-backend-mint"].detail,
    kinds: ["issuer-or-backend-mint"],
  },
  {
    term: "Bridge",
    description: MINT_AUTHORITY_STATUS_CONFIG["bridge-mint"].detail,
    kinds: ["bridge-mint"],
  },
  {
    term: "Inherited",
    description: MINT_AUTHORITY_STATUS_CONFIG["inherited-authority"].detail,
    kinds: ["inherited-authority"],
  },
];

export const coverageFeature = defineCoverageFeature({
  statusKinds: MINT_AUTHORITY_KINDS,
  legendItems: MINT_AUTHORITY_LEGEND,
  resolve: resolveMintAuthority,
  formatBreakdown: formatMintAuthority,
});
