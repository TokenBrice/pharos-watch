import type { MintAuthorityCoverageSummary } from "@shared/types/stablecoin-client-meta";
import { resolveV9MintPostureBand } from "@shared/lib/safety-score-v9/mint-posture";
import {
  MINT_AUTHORITY_SCORE_DESCRIPTORS,
  MINT_AUTHORITY_SCORE_FILTER_CONFIG,
  MINT_AUTHORITY_STATUS_CONFIG,
  resolveMintAuthorityStatusKind,
  type MintAuthorityScoreFilterValue,
  type MintAuthorityStatusConfig,
} from "@shared/lib/classification";


/**
 * The published V9 mint component, as every cross-coin surface reads it off
 * `card.breakdowns.control.components`. `breakdowns` is nullable on older
 * publications, so an absent component is a first-class NR rather than an error.
 */
export interface PublishedMintComponent {
  score: number | null;
  posture: string | null;
}

/**
 * Why a mint pill can look "amber at 81" beside a green pillar: its tone is
 * the published posture band, not a numeric cutoff (retired in V9.1).
 * Appended to every mint score pill tooltip.
 */
export const MINT_AUTHORITY_TONE_NOTE =
  "The pill tone follows the posture band; numeric mint score cutoffs were retired in V9.1.";

export interface MintAuthorityScoreDisplay {
  score: number | null;
  posture: string | null;
  scoreLabel: string;
  /** Score with its band beside it ("81 · Managed"), or "NR". */
  compactLabel: string;
  bandKey: MintAuthorityScoreFilterValue;
  bandLabel: string;
  badgeClassName: string;
  textClassName: string;
  detail: string;
}

/**
 * Safety 9.1: the mint score and band are read from the published V9 mint
 * component instead of recomputed in the browser from curated inputs. The
 * band comes from the published posture, so it stays stable when a bounded
 * merged-signal credit or penalty moves the component by a point.
 */
export function resolveMintAuthorityScoreDisplay(
  mint?: PublishedMintComponent | null,
): MintAuthorityScoreDisplay {
  const band = resolveV9MintPostureBand(mint?.posture);
  const bandKey: MintAuthorityScoreFilterValue = band ?? "nr";
  const score = band === null ? null : (mint?.score ?? null);
  const bandLabel = MINT_AUTHORITY_SCORE_FILTER_CONFIG[bandKey].label;
  const scoreLabel = score != null ? `${score}/100` : "NR";
  const compactLabel = score != null ? `${score} · ${bandLabel}` : "NR";
  const detail =
    score != null
      ? `Mint control posture: ${scoreLabel} (${bandLabel}). ${mint?.posture === "unbounded-operationally-governed"
        ? "Discretionary expansion and operational-envelope changes require public token governance; formula interest and activity-bound compensation can execute immediately within reviewed envelopes. Economically unbounded."
        : MINT_AUTHORITY_SCORE_FILTER_CONFIG[bandKey].detail}`
      : MINT_AUTHORITY_SCORE_FILTER_CONFIG.nr.detail;

  return {
    score,
    posture: mint?.posture ?? null,
    scoreLabel,
    compactLabel,
    bandKey,
    bandLabel,
    badgeClassName: `${MINT_AUTHORITY_SCORE_DESCRIPTORS[bandKey].badgeClassName} ${MINT_AUTHORITY_SCORE_DESCRIPTORS[bandKey].textClassName}`,
    textClassName: MINT_AUTHORITY_SCORE_DESCRIPTORS[bandKey].textClassName,
    detail,
  };
}


export function resolveMintAuthorityStatus(
  summary?: MintAuthorityCoverageSummary | null,
): MintAuthorityStatusConfig {
  return MINT_AUTHORITY_STATUS_CONFIG[resolveMintAuthorityStatusKind(summary)];
}
