import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import {
  breakdownItem,
  createBreakdownCounter,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
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
  type PublishedMintComponent,
} from "@/lib/mint-authority-display";

/**
 * The curation-route buckets stay curated (they describe *which* review path an
 * asset is on). Safety 9.1 re-sources only the score buckets, which now come
 * from the published V9 mint component instead of a browser recomputation.
 *
 * That split is why this feature degrades in halves rather than all at once.
 * When the report-cards query has no data the curated route bucket is still
 * true, so the cell keeps it; but the score and its band are simply not known
 * yet, and reporting them as "not rated" would be indistinguishable from a
 * genuine NR. They collapse into the shared `data-unavailable` band instead, so
 * the score dimension shows a Data n/a affordance the way every other
 * query-backed feature already does.
 */
function resolveMintAuthority(
  summary?: MintAuthorityCoverageSummary | null,
  publishedMint?: PublishedMintComponent | null,
  scoreDataAvailable = true,
): CoverageStatus {
  const status = resolveMintAuthorityStatus(summary);
  if (!scoreDataAvailable) {
    return { ...createPresetStatus(status), score: null, scoreBand: DATA_UNAVAILABLE_KIND };
  }

  const score = resolveMintAuthorityScoreDisplay(publishedMint);
  return {
    ...createPresetStatus(status),
    score: score.score,
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
    // Without this the score bands would all read zero when the report-cards
    // query is down, which looks like "nothing is rated" rather than "the scores
    // have not arrived".
    breakdownItem(`score-${DATA_UNAVAILABLE_KIND}`, "data n/a", scoreBandCount(DATA_UNAVAILABLE_KIND)),
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
