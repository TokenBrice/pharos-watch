import { round4 } from "@shared/lib/math";
import { ACTIVE_IDS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { LiquiditySourceMix } from "@shared/types/market";
import type { DexLiquidityCronMetadata } from "../../lib/schemas";
import type { DexPriceObs, FullScoreResult } from "./types";

export const DRIFT_WATCHLIST = ["usdc-circle", "usdt-tether", "dai-makerdao", "usds-sky", "usde-ethena"] as const;

/**
 * A drift condition has to hold for this many consecutive productive runs,
 * measured against the same pre-event baseline, before it becomes a reported
 * flag. A single-generation diff both fires and self-silences on one noisy
 * hour, because the collapsed value becomes the next baseline as soon as it
 * publishes. Confirmation removes every one-hour blip and, in exchange, keeps
 * a real loss visible until the value recovers or is accepted as the new level.
 */
const DRIFT_CONFIRMATION_RUNS = 2;

/**
 * A confirmed condition is reported on runs `DRIFT_CONFIRMATION_RUNS` through
 * `DRIFT_REBASELINE_RUNS` (~5 hourly publications). If it still holds on the
 * next run it is a lasting step change rather than a transient hole, so it is
 * accepted as the new level: the candidate is dropped, the flag stops, and the
 * acceptance is recorded in `qualityDriftRebaselined`. Without this an
 * explained step (a venue delisting, a de-duplicated protocol) kept the
 * pre-event baseline forever and warned indefinitely. Because the candidate is
 * gone, the following run measures against the accepted value, so a further
 * step is detected and confirmed from scratch.
 */
export const DRIFT_REBASELINE_RUNS = 6;

export type PreviousDexLiquiditySummary = {
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  priceObservationCoins: number;
  measuredBalanceCoveragePct: number;
  weakCoverageCoins: number;
  /** Retained pool count per source family; null when the row predates the field. */
  retainedPoolCountBySourceFamily: Record<string, number> | null;
};

type DexLiquiditySourceCoverage = DexLiquidityCronMetadata["sourceCoverage"];

/**
 * Pending or confirmed drift condition carried between runs. `baselineValue`
 * is the pre-event baseline — the last run whose value was not itself flagged —
 * and never the previous run's already-collapsed value, so a condition that is
 * still present stays reported after the publication that overwrote the row it
 * was first measured against.
 */
export type DexLiquidityDriftCandidate = NonNullable<DexLiquiditySourceCoverage["qualityDriftCandidates"]>[number];

/**
 * A confirmed condition accepted as the new level. `runs` counts every
 * consecutive run the condition held, including the accepting run.
 */
export type DexLiquidityDriftRebaseline = NonNullable<DexLiquiditySourceCoverage["qualityDriftRebaselined"]>[number];


function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round4((current - previous) / previous);
}

export function readPreviousDexLiquiditySummary(parsed: DexLiquidityCronMetadata | null): PreviousDexLiquiditySummary | null {
  if (!parsed) return null;
  const retainedPoolCountBySourceFamily = parsed.sourceCoverage.retainedPoolCountBySourceFamily;
  return {
    stagedPoolsMerged: parsed.stagedPoolsMerged ?? 0,
    stagedPoolsSkipped: parsed.stagedPoolsSkipped ?? 0,
    priceObservationCoins: parsed.sourceCoverage.priceObservationCoins ?? 0,
    measuredBalanceCoveragePct: parsed.sourceCoverage.measuredBalanceCoveragePct ?? 0,
    weakCoverageCoins: parsed.sourceCoverage.weakCoverageCoins ?? 0,
    retainedPoolCountBySourceFamily:
      retainedPoolCountBySourceFamily && Object.keys(retainedPoolCountBySourceFamily).length > 0
        ? retainedPoolCountBySourceFamily
        : null,
  };
}

export function readPreviousDexLiquidityDriftCandidates(
  parsed: DexLiquidityCronMetadata | null,
): DexLiquidityDriftCandidate[] {
  const candidates = parsed?.sourceCoverage.qualityDriftCandidates;
  if (!candidates) return [];
  return candidates.filter((candidate) => Number.isFinite(candidate.baselineValue));
}

/**
 * A previously-major coin whose TVL lands below this fraction of its prior
 * published value is reported as a per-coin cliff. Same bound as
 * `hardValueGuard`/`hardMajorCoverageGuard`, which abort the run on the same
 * ratio in aggregate. Those aggregate guards cannot see a single coin's hole:
 * USDS shed ~91% of its measured TVL on 2026-08-20 while global and top-10
 * totals stayed inside every bound, and edition #179 published the hole as news.
 */
const MAJOR_TVL_CLIFF_RATIO = 0.6;

/** Prior TVL below this is dust oscillation, not a cliff worth flagging. */
const MAJOR_TVL_CLIFF_MIN_PREVIOUS_USD = 5_000_000;

/**
 * Per-chain TVL and per-source-family pool retention are the cohorts the
 * aggregate guards cannot resolve. A confirmed >10% shrink against the
 * pre-event baseline is reported as `chain-tvl-drop:<chain>` /
 * `source-family-drop:<family>` and is the only drift series that does not
 * rebaseline after `DRIFT_REBASELINE_RUNS`: a lasting chain or source loss is
 * exactly the condition an operator must resolve, not a new accepted level.
 */
const COHORT_DROP_RATIO = 0.1;
const COHORT_MIN_PREVIOUS_TVL_USD = 1_000_000;
const COHORT_SOURCE_FAMILY_MIN_PREVIOUS_POOLS = 5;
const CHAIN_TVL_DROP_FLAG_PREFIX = "chain-tvl-drop:";
export const SOURCE_FAMILY_DROP_FLAG_PREFIX = "source-family-drop:";

export const REVIEWED_SOURCE_FAMILY_DISPOSITIONS = [
  {
    flag: "source-family-drop:gecko_terminal", baselineValue: 23, reviewedAt: "2026-11-05",
    reason: "All 16 lost pools were USDC dust worth $449.57 total, pruned by the 2026-11-05 00:06Z discovery cleanup.",
  },
  {
    flag: "source-family-drop:dexscreener", baselineValue: 338, reviewedAt: "2026-11-05",
    reason: "Re-attribution after the 2026-11-05 06:06Z discovery stale-pool refresh: e.g. USD1's $23.09M of DexScreener pools reappeared under cg_onchain with coin TVL unchanged; residual DexScreener TVL moves were immaterial.",
  },
] as const satisfies NonNullable<DexLiquidityCronMetadata["sourceCoverage"]["qualityDriftAccepted"]>;

export const REVIEWED_CHAIN_TVL_DISPOSITIONS = [{
  flag: "chain-tvl-drop:blast", baselineValue: 9_232_068.94230654, observedValue: 26_138.05097650291,
  retiredStablecoinId: "usdb-blast", reviewedAt: "2026-11-07T20:31:00Z", expiresAt: "2026-11-21T20:31:00Z",
  evidenceUrls: ["https://x.com/blast/status/2106032805280891073"],
  reason: "USDB was frozen on 2026-11-02 after Blast's L2 wind-down; its archived $9.232M is excluded from live aggregation.",
}, {
  flag: "chain-tvl-drop:mezo", baselineValue: 5_292_320.059906746, observedValue: 255_927.62449999998,
  retiredStablecoinId: null, reviewedAt: "2026-11-07T20:31:00Z", expiresAt: "2026-11-21T20:31:00Z",
  evidenceUrls: ["https://api.llama.fi/protocol/mezo-tigris", "https://api.geckoterminal.com/api/v2/networks/mezo/tokens/0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186/pools?page=1"],
  reason: "Mezo Tigris MUSD TVL fell from $11.806M to $1.408M on Nov 5-6; current observed token pools total $276k, corroborating the retained $256k.",
}] as const;

const MAJOR_TVL_CLIFF_FLAG_PREFIX = "major-tvl-cliff:";

export type DexLiquidityDriftWatchlistDelta = NonNullable<DexLiquiditySourceCoverage["topAssetCoverageDeltas"]>[number];

export type DexLiquidityMajorTvlCliff = NonNullable<DexLiquiditySourceCoverage["majorTvlCliffs"]>[number];

export interface DexLiquidityDriftSummary {
  qualityDriftFlags: string[];
  /**
   * Confirmed per-chain/per-source-family cohort drops. They also appear in
   * `qualityDriftFlags`; only source-family pool loss marks input quality
   * degraded, while chain TVL movement remains an operator warning.
   */
  cohortDriftFlags: string[];
  qualityDriftCandidates: DexLiquidityDriftCandidate[];
  qualityDriftAccepted: NonNullable<DexLiquidityCronMetadata["sourceCoverage"]["qualityDriftAccepted"]>;
  qualityDriftRebaselined: DexLiquidityDriftRebaseline[];
  qualityDriftSeverity: "none" | "medium" | "high";
  qualityDriftMetrics: Required<NonNullable<DexLiquiditySourceCoverage["qualityDriftMetrics"]>>;
  topAssetCoverageDeltas: DexLiquidityDriftWatchlistDelta[];
  majorTvlCliffs: DexLiquidityMajorTvlCliff[];
}

/**
 * Advances one pending condition by a run. The pre-event baseline from a
 * previous candidate wins over this run's own previous value; a condition that
 * no longer holds against that baseline clears the candidate, which is how a
 * recovered flag ends. The caller rebaselines a condition that outlives
 * `DRIFT_REBASELINE_RUNS`.
 */
function advanceDriftCandidate(
  previous: DexLiquidityDriftCandidate | undefined,
  naturalBaseline: number,
  conditionHolds: (baselineValue: number) => boolean,
): Pick<DexLiquidityDriftCandidate, "baselineValue" | "consecutiveRuns"> | null {
  const baselineValue =
    previous && Number.isFinite(previous.baselineValue) ? previous.baselineValue : naturalBaseline;
  if (!Number.isFinite(baselineValue) || !conditionHolds(baselineValue)) return null;
  const previousRuns = previous && Number.isFinite(previous.consecutiveRuns) ? previous.consecutiveRuns : 0;
  return { baselineValue, consecutiveRuns: Math.max(0, previousRuns) + 1 };
}

export function computeDexLiquidityDriftSummary(params: {
  nowSec?: number;
  previousSummary: PreviousDexLiquiditySummary | null;
  previousCandidates: DexLiquidityDriftCandidate[];
  priceObservations: Map<string, DexPriceObs[]>;
  stagedMergedCount: number;
  stagedSkippedCount: number;
  weakCoverageCoinsBeforeFallback: number;
  measuredBalanceCoveragePct: number;
  watchlistPreviousById: Map<string, {
    stablecoin_id: string;
    pool_count: number;
    coverage_confidence: number | null;
    total_tvl_usd: number;
    balance_measured_tvl_usd: number;
  }>;
  scoreResults: Map<string, FullScoreResult>;
  /**
   * Prior published TVL, including material coins outside the top ten. This
   * remains available after a cliff is rebaselined and its candidate is dropped.
   */
  previousMajorTvlById: Map<string, number>;
  /** Previous published generation's per-chain TVL; omitted/unknown skips the comparison. */
  previousChainTvl?: Record<string, number> | null;
  currentChainTvl?: Record<string, number>;
  /** Previous retained pool count per source family; omitted/unknown skips the comparison. */
  previousSourceFamilyPools?: Record<string, number> | null;
  currentSourceFamilyPools?: Record<string, number>;
  /** Already-read previous published rows; null/omitted means unavailable, not empty. */
  previousSourceMixById?: Map<string, LiquiditySourceMix> | null;
}): DexLiquidityDriftSummary {
  const previousCandidatesByFlag = new Map(params.previousCandidates.map((candidate) => [candidate.flag, candidate]));
  const candidates: DexLiquidityDriftCandidate[] = [];
  const qualityDriftFlags: string[] = [];
  const cohortDriftFlags: string[] = [];
  const qualityDriftRebaselined: DexLiquidityDriftRebaseline[] = [];
  const qualityDriftAccepted: DexLiquidityDriftSummary["qualityDriftAccepted"] = [];
  const nowSec = params.nowSec ?? Date.now() / 1000;

  const confirmCondition = (
    flag: string,
    naturalBaseline: number,
    observedValue: number,
    conditionHolds: (baselineValue: number) => boolean,
  ): DexLiquidityDriftCandidate | null => {
    const advanced = advanceDriftCandidate(previousCandidatesByFlag.get(flag), naturalBaseline, conditionHolds);
    if (!advanced) return null;
    if (advanced.consecutiveRuns > DRIFT_REBASELINE_RUNS) {
      qualityDriftRebaselined.push({
        flag,
        baselineValue: advanced.baselineValue,
        acceptedValue: observedValue,
        runs: advanced.consecutiveRuns,
      });
      return null;
    }
    const candidate: DexLiquidityDriftCandidate = { flag, ...advanced, observedValue };
    candidates.push(candidate);
    if (advanced.consecutiveRuns >= DRIFT_CONFIRMATION_RUNS) qualityDriftFlags.push(flag);
    return candidate;
  };

  /**
   * Cohort series share the confirmation window but never rebaseline: a lasting
   * chain or source-family loss must keep the finding visible until recovery.
   */
  const confirmCohortCondition = (
    flag: string,
    naturalBaseline: number,
    observedValue: number,
    conditionHolds: (baselineValue: number) => boolean,
    sourceFamilyTvlEvidence?: DexLiquidityDriftCandidate["sourceFamilyTvlEvidence"],
  ): void => {
    const advanced = advanceDriftCandidate(previousCandidatesByFlag.get(flag), naturalBaseline, conditionHolds);
    if (!advanced) return;
    candidates.push({ flag, ...advanced, observedValue, ...(sourceFamilyTvlEvidence ? { sourceFamilyTvlEvidence } : {}) });
    if (advanced.consecutiveRuns >= DRIFT_CONFIRMATION_RUNS) {
      qualityDriftFlags.push(flag);
      cohortDriftFlags.push(flag);
    }
  };

  /**
   * Cohorts come from the previous published generation plus any carried
   * candidate. A cohort that already collapsed below the materiality floor (or
   * vanished from the published map) is invisible there, so its carried
   * pre-event baseline is the one the floor must admit.
   */
  const cohortBaselines = (
    previous: Record<string, number> | null | undefined,
    flagPrefix: string,
    minBaseline: number,
  ): Map<string, number> => {
    const baselines = new Map<string, number>();
    for (const [key, value] of Object.entries(previous ?? {})) {
      if (!Number.isFinite(value) || value < minBaseline) continue;
      baselines.set(key, value);
    }
    for (const candidate of params.previousCandidates) {
      if (!candidate.flag.startsWith(flagPrefix)) continue;
      const key = candidate.flag.slice(flagPrefix.length);
      if (key.length === 0 || !Number.isFinite(candidate.baselineValue)) continue;
      if (candidate.baselineValue < minBaseline) continue;
      if (!baselines.has(key)) baselines.set(key, candidate.baselineValue);
    }
    return baselines;
  };

  const watchlistDeltas = DRIFT_WATCHLIST.map((stablecoinId) => {
    const previous = params.watchlistPreviousById.get(stablecoinId);
    const currentScore = params.scoreResults.get(stablecoinId);
    // The coin's published pool count — the quantity persistence writes to
    // `dex_liquidity.pool_count` — instead of a curated subset of the same pool
    // set, so the delta always compares like with like.
    const currentPoolCount = Object.values(currentScore?.sourceMix ?? {}).reduce(
      (sum, entry) => sum + (entry?.poolCount ?? 0),
      0,
    );
    const currentMeasuredShare =
      currentScore && currentScore.tvl > 0
        ? Math.max(0, Math.min(1, currentScore.balanceMeasuredTvlUsd / currentScore.tvl))
        : 0;
    const previousMeasuredShare =
      previous && previous.total_tvl_usd > 0
        ? Math.max(0, Math.min(1, (previous.balance_measured_tvl_usd ?? 0) / previous.total_tvl_usd))
        : 0;
    return {
      stablecoinId,
      previousPoolCount: previous?.pool_count ?? 0,
      currentPoolCount,
      poolCountPctDelta: pctDelta(currentPoolCount, previous?.pool_count ?? 0),
      previousCoverageConfidence: previous?.coverage_confidence ?? null,
      currentCoverageConfidence: currentScore?.coverageConfidence ?? null,
      previousMeasuredShare: previous ? round4(previousMeasuredShare) : null,
      currentMeasuredShare: currentScore ? round4(currentMeasuredShare) : null,
    };
  });

  const cliffBaselines = new Map<string, number>();
  for (const [stablecoinId, previousTvlUsd] of params.previousMajorTvlById) {
    if (previousTvlUsd < MAJOR_TVL_CLIFF_MIN_PREVIOUS_USD) continue;
    cliffBaselines.set(stablecoinId, previousTvlUsd);
  }
  // A confirmed cliff keeps its pre-event baseline even once the coin drops out
  // of the previous top ten, which is exactly when the overwritten baseline
  // would otherwise hide it.
  for (const candidate of params.previousCandidates) {
    if (!candidate.flag.startsWith(MAJOR_TVL_CLIFF_FLAG_PREFIX)) continue;
    const stablecoinId = candidate.flag.slice(MAJOR_TVL_CLIFF_FLAG_PREFIX.length);
    if (stablecoinId.length === 0 || !Number.isFinite(candidate.baselineValue)) continue;
    if (!cliffBaselines.has(stablecoinId)) cliffBaselines.set(stablecoinId, candidate.baselineValue);
  }

  const majorTvlCliffs: DexLiquidityMajorTvlCliff[] = [];
  for (const [stablecoinId, naturalBaseline] of cliffBaselines) {
    // Archived rows and carried candidates outlive their eligibility for live scoring.
    if (!ACTIVE_IDS.has(stablecoinId)) continue;
    const currentTvlUsd = params.scoreResults.get(stablecoinId)?.tvl ?? 0;
    const candidate = confirmCondition(
      `${MAJOR_TVL_CLIFF_FLAG_PREFIX}${stablecoinId}`,
      naturalBaseline,
      currentTvlUsd,
      (baselineValue) => currentTvlUsd < baselineValue * MAJOR_TVL_CLIFF_RATIO,
    );
    if (!candidate) continue;
    majorTvlCliffs.push({
      stablecoinId,
      previousTvlUsd: candidate.baselineValue,
      currentTvlUsd,
      tvlPctDelta: pctDelta(currentTvlUsd, candidate.baselineValue),
    });
  }

  const priceObservationCoins = params.priceObservations.size;
  const priceObservationPctDelta = params.previousSummary
    ? pctDelta(priceObservationCoins, params.previousSummary.priceObservationCoins)
    : null;
  const stagedPoolsMergedPctDelta = params.previousSummary
    ? pctDelta(params.stagedMergedCount, params.previousSummary.stagedPoolsMerged)
    : null;
  const stagedPoolsSkippedPctDelta = params.previousSummary
    ? pctDelta(params.stagedSkippedCount, params.previousSummary.stagedPoolsSkipped)
    : null;
  const measuredBalanceCoverageDelta = params.previousSummary
    ? round4(params.measuredBalanceCoveragePct - params.previousSummary.measuredBalanceCoveragePct)
    : null;
  const weakCoverageDelta = params.previousSummary
    ? params.weakCoverageCoinsBeforeFallback - params.previousSummary.weakCoverageCoins
    : null;

  if (params.previousSummary) {
    const previous = params.previousSummary;
    confirmCondition("price-observation-drop", previous.priceObservationCoins, priceObservationCoins, (baselineValue) => {
      const delta = pctDelta(priceObservationCoins, baselineValue);
      return delta != null && delta <= -0.1;
    });
    confirmCondition("staged-merge-drop", previous.stagedPoolsMerged, params.stagedMergedCount, (baselineValue) => {
      const delta = pctDelta(params.stagedMergedCount, baselineValue);
      return delta != null && delta <= -0.1;
    });
    confirmCondition(
      "measured-balance-drop",
      previous.measuredBalanceCoveragePct,
      params.measuredBalanceCoveragePct,
      (baselineValue) => round4(params.measuredBalanceCoveragePct - baselineValue) <= -0.08,
    );
    confirmCondition(
      "weak-coverage-rise",
      previous.weakCoverageCoins,
      params.weakCoverageCoinsBeforeFallback,
      (baselineValue) => params.weakCoverageCoinsBeforeFallback - baselineValue >= 5,
    );
  }

  for (const delta of watchlistDeltas) {
    confirmCondition(
      `watchlist-pool-drop:${delta.stablecoinId}`,
      delta.previousPoolCount,
      delta.currentPoolCount,
      (baselineValue) => {
        const change = pctDelta(delta.currentPoolCount, baselineValue);
        return change != null && change <= -0.2;
      },
    );
  }

  if (params.currentChainTvl != null && Object.keys(params.currentChainTvl).length > 0) {
    for (const [chain, baseline] of cohortBaselines(
      params.previousChainTvl,
      CHAIN_TVL_DROP_FLAG_PREFIX,
      COHORT_MIN_PREVIOUS_TVL_USD,
    )) {
      const currentTvl = params.currentChainTvl[chain] ?? 0;
      const flag = `${CHAIN_TVL_DROP_FLAG_PREFIX}${chain}`;
      confirmCohortCondition(
        flag,
        baseline,
        currentTvl,
        (baselineValue) => currentTvl < baselineValue * (1 - COHORT_DROP_RATIO),
      );
      const candidate = candidates.find((entry) => entry.flag === flag);
      const review = REVIEWED_CHAIN_TVL_DISPOSITIONS.find((entry) => entry.flag === flag
        && entry.baselineValue === candidate?.baselineValue
        && (entry.retiredStablecoinId == null || FROZEN_IDS.has(entry.retiredStablecoinId))
        && nowSec >= Date.parse(entry.reviewedAt) / 1000 && nowSec < Date.parse(entry.expiresAt) / 1000
        && Math.abs(currentTvl - entry.observedValue) <= entry.observedValue * 0.02);
      if (review) {
        // Keep the held baseline diagnostic so expiry or a changed level reopens the finding.
        qualityDriftAccepted.push({ ...review, evidenceUrls: [...review.evidenceUrls] });
        for (const flags of [qualityDriftFlags, cohortDriftFlags]) {
          const index = flags.indexOf(flag);
          if (index >= 0) flags.splice(index, 1);
        }
      }
    }
  }

  if (params.currentSourceFamilyPools != null) {
    for (const [family, baseline] of cohortBaselines(
      params.previousSourceFamilyPools,
      SOURCE_FAMILY_DROP_FLAG_PREFIX,
      COHORT_SOURCE_FAMILY_MIN_PREVIOUS_POOLS,
    )) {
      const currentPools = params.currentSourceFamilyPools[family] ?? 0;
      const flag = `${SOURCE_FAMILY_DROP_FLAG_PREFIX}${family}`;
      const previousCandidate = previousCandidatesByFlag.get(flag);
      let evidence = previousCandidate?.sourceFamilyTvlEvidence;
      // Reviewed dispositions accept only legacy candidates opened before TVL evidence existed;
      // a candidate admitted with evidence is a new loss even when its pool baseline repeats.
      if (previousCandidate && evidence === undefined) {
        const disposition = REVIEWED_SOURCE_FAMILY_DISPOSITIONS.find(
          (entry) => entry.flag === flag && entry.baselineValue === previousCandidate.baselineValue,
        );
        if (disposition) {
          qualityDriftAccepted.push(disposition);
          continue;
        }
      }
      // Admit once against the pre-loss generation; later publications already contain the loss.
      if (!previousCandidate) {
        let baselineTvlUsd = 0;
        let unexplainedLossUsd = 0;
        for (const [stablecoinId, previousMix] of params.previousSourceMixById ?? []) {
          const previousTvl = previousMix[family]?.tvlUsd ?? 0;
          baselineTvlUsd += previousTvl;
          const currentMix: LiquiditySourceMix = params.scoreResults.get(stablecoinId)?.sourceMix ?? {};
          const loss = Math.max(0, previousTvl - (currentMix[family]?.tvlUsd ?? 0));
          let gains = 0;
          let losses = 0;
          for (const source of new Set([...Object.keys(previousMix), ...Object.keys(currentMix)])) {
            const delta = (currentMix[source]?.tvlUsd ?? 0) - (previousMix[source]?.tvlUsd ?? 0);
            gains += Math.max(0, delta);
            losses += Math.max(0, -delta);
          }
          unexplainedLossUsd += loss * (losses > 0 ? 1 - Math.min(1, gains / losses) : 0);
        }
        const available = params.previousSourceMixById != null;
        if (available && (baselineTvlUsd < COHORT_MIN_PREVIOUS_TVL_USD || unexplainedLossUsd < baselineTvlUsd * COHORT_DROP_RATIO)) continue;
        const currentTvlUsd = Array.from(params.scoreResults.values())
          .reduce((sum, score) => {
            const mix: LiquiditySourceMix = score.sourceMix;
            return sum + (mix[family]?.tvlUsd ?? 0);
          }, 0);
        evidence = {
          explanation: available ? "evaluated" : "unavailable",
          baselineTvlUsd: available ? baselineTvlUsd : null,
          currentTvlUsd,
          unexplainedLossUsd: available ? unexplainedLossUsd : null,
        };
      }
      confirmCohortCondition(
        flag,
        baseline,
        currentPools,
        (baselineValue) => currentPools < baselineValue * (1 - COHORT_DROP_RATIO),
        evidence,
      );
    }
  }

  const qualityDriftSeverity: DexLiquidityDriftSummary["qualityDriftSeverity"] =
    qualityDriftFlags.length === 0
      ? "none"
      : qualityDriftFlags.some(
            (flag) =>
              flag === "measured-balance-drop" ||
              flag.startsWith("watchlist-pool-drop:") ||
              flag.startsWith(MAJOR_TVL_CLIFF_FLAG_PREFIX) ||
              flag.startsWith(CHAIN_TVL_DROP_FLAG_PREFIX) ||
              flag.startsWith(SOURCE_FAMILY_DROP_FLAG_PREFIX),
          )
        ? "high"
        : "medium";

  return {
    qualityDriftFlags,
    cohortDriftFlags,
    qualityDriftCandidates: candidates,
    qualityDriftAccepted,
    qualityDriftRebaselined,
    qualityDriftSeverity,
    qualityDriftMetrics: {
      previousPriceObservationCoins: params.previousSummary?.priceObservationCoins ?? null,
      currentPriceObservationCoins: priceObservationCoins,
      priceObservationPctDelta,
      previousMeasuredBalanceCoveragePct: params.previousSummary?.measuredBalanceCoveragePct ?? null,
      currentMeasuredBalanceCoveragePct: params.measuredBalanceCoveragePct,
      measuredBalanceCoverageDelta,
      previousStagedPoolsMerged: params.previousSummary?.stagedPoolsMerged ?? null,
      currentStagedPoolsMerged: params.stagedMergedCount,
      stagedPoolsMergedPctDelta,
      previousStagedPoolsSkipped: params.previousSummary?.stagedPoolsSkipped ?? null,
      currentStagedPoolsSkipped: params.stagedSkippedCount,
      stagedPoolsSkippedPctDelta,
      previousWeakCoverageCoins: params.previousSummary?.weakCoverageCoins ?? null,
      currentWeakCoverageCoins: params.weakCoverageCoinsBeforeFallback,
      weakCoverageDelta,
    },
    topAssetCoverageDeltas: watchlistDeltas,
    majorTvlCliffs,
  };
}
