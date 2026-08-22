// Editorial admission rules for day-over-day DEX liquidity comparisons.
//
// Edition #179 (2026-08-21) led with "USDS bled 91% of its DEX liquidity to
// $13.72M in a day". The claim was an ingestion artifact: DefiLlama's project
// index and the direct-API pool fetchers can return partial inventories, whose
// dropped pools collapse one coin's measured TVL while every producer guard
// (aggregate row coverage, global TVL, top-10 TVL) stays inside its 60-85%
// bounds. The digest's liquidity collector then compared two `dex_liquidity_history`
// rows on score and market cap alone, so the collapsed row became the lead.
//
// These rules decide whether a pair of history rows is a comparable measurement
// of the same thing on two adjacent days. They are deliberately fail-closed:
// an inadmissible pair produces no editorial signal at all rather than a
// hedged one, because the prompt renders raw TVL evidence the model can quote.
import { isTrendworthyLiquiditySnapshot } from "./dex-liquidity-evidence";
import { LIQUIDITY_SCORE_WEIGHTS } from "./liquidity-score-weights";

const ONE_DAY_SEC = 86_400;

/**
 * A single-day raw-TVL drop of at least this fraction cannot lead on its own:
 * an independent pipeline has to confirm it first. The bound is the producer's
 * own "this cannot be real" line — `sync-dex-liquidity` aborts publication when
 * global or top-10 TVL lands below 60% of the prior run, a 40% drop
 * (`hardValueGuard` / `hardMajorCoverageGuard` in
 * worker/src/cron/dex-liquidity/orchestrator-analysis.ts). Those guards are
 * aggregate-only, so this applies the same bound per coin. It also clears the
 * largest documented methodology recompute: v6.0's Raydium de-duplication moved
 * individual coins 2-35% (shared/data/methodology-changelogs/liquidity-score/v6.ts).
 *
 * This is an *editorial* threshold, not an admission rule. Magnitude alone
 * cannot distinguish an artifact from a real drain, and only the candidate
 * layer can see the depeg, flow, and supply evidence that tells them apart.
 * Rejecting large moves here would have discarded genuine crises unread.
 */
export const UNCORROBORATED_TVL_DROP_RATIO = 0.4;

/** TVL Depth is a log-scale component; see docs/dex-liquidity.md. */
const TVL_DEPTH_LOG_COEFFICIENT = 35;
const TVL_DEPTH_WEIGHT =
  LIQUIDITY_SCORE_WEIGHTS.find((component) => component.key === "tvlDepth")?.weight ?? 0.3;

/**
 * Reasons a history pair is not a comparable measurement of the same thing on
 * two adjacent days. Every rule is decidable from the pair itself; editorial
 * judgments that need other pipelines belong downstream.
 */
export type LiquidityShiftRejection =
  /** The two rows are not exactly one day apart, so the delta spans a gap. */
  | "non-adjacent-snapshots"
  /** The rows were scored under different methodology versions: a recompute, not a market move. */
  | "methodology-basis-change"
  /** Either row is fallback-sourced, low-confidence, or non-finite, so it cannot carry a trend. */
  | "non-trendworthy-coverage";

export interface LiquidityShiftSnapshot {
  snapshotDate: number;
  liquidityScore: number;
  totalTvlUsd: number;
  coverageClass: string | null;
  coverageConfidence: number | null;
  methodologyVersion: string | null;
}

export interface LiquidityShiftAdmission {
  admissible: boolean;
  rejection?: LiquidityShiftRejection;
  /** Fractional raw-TVL change, e.g. -0.91 for a 91% drop. Null when the prior row had no TVL. */
  tvlChangePct: number | null;
  /**
   * Score move the TVL change alone implies under the current methodology
   * (TVL Depth is `35 * log10(depthRatio / 0.0007)` at a 30% weight). Reported
   * so the prompt cannot frame log-scale compression as the score failing to
   * react: a 91% TVL drop mathematically implies only about -11 composite points.
   * Null when either side is non-positive or the change is nil.
   */
  expectedScoreDeltaFromTvl: number | null;
}

function expectedScoreDeltaFromTvl(previousTvl: number, currentTvl: number): number | null {
  if (previousTvl <= 0 || currentTvl <= 0 || previousTvl === currentTvl) return null;
  return TVL_DEPTH_WEIGHT * TVL_DEPTH_LOG_COEFFICIENT * Math.log10(currentTvl / previousTvl);
}

/**
 * Decide whether a `dex_liquidity_history` pair is a comparable measurement of
 * the same thing on two adjacent days. `previous` must be the row immediately
 * before `latest`.
 *
 * Comparability only. Whether an admitted move is publishable — and whether it
 * may lead — is decided by the candidate layer, which can see the depeg, flow,
 * and supply evidence that separates a real drain from a partial snapshot.
 */
export function admitLiquidityShift(
  latest: LiquidityShiftSnapshot,
  previous: LiquidityShiftSnapshot,
): LiquidityShiftAdmission {
  const tvlChangePct =
    previous.totalTvlUsd > 0 ? (latest.totalTvlUsd - previous.totalTvlUsd) / previous.totalTvlUsd : null;
  const context: Omit<LiquidityShiftAdmission, "admissible" | "rejection"> = {
    tvlChangePct,
    expectedScoreDeltaFromTvl: expectedScoreDeltaFromTvl(previous.totalTvlUsd, latest.totalTvlUsd),
  };
  const reject = (rejection: LiquidityShiftRejection): LiquidityShiftAdmission => ({
    admissible: false,
    rejection,
    ...context,
  });

  if (
    !Number.isFinite(latest.liquidityScore) ||
    !Number.isFinite(previous.liquidityScore) ||
    !Number.isFinite(latest.totalTvlUsd) ||
    !Number.isFinite(previous.totalTvlUsd)
  ) {
    return reject("non-trendworthy-coverage");
  }
  if (latest.snapshotDate - previous.snapshotDate !== ONE_DAY_SEC) {
    return reject("non-adjacent-snapshots");
  }
  if (latest.methodologyVersion !== previous.methodologyVersion) {
    return reject("methodology-basis-change");
  }
  if (
    !isTrendworthyLiquiditySnapshot(latest.totalTvlUsd, latest.coverageClass, latest.coverageConfidence) ||
    !isTrendworthyLiquiditySnapshot(previous.totalTvlUsd, previous.coverageClass, previous.coverageConfidence)
  ) {
    return reject("non-trendworthy-coverage");
  }

  return { admissible: true, ...context };
}
