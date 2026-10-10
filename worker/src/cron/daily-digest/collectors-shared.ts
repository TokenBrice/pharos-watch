import { logWorkerEventArgs } from "../../lib/structured-log";
import type {
  DigestInputData,
  DigestSafetyContext,
  DigestV9SafetyCap,
  DigestV9SafetyCoin,
} from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { DigestEvidence } from "./digest-evidence";

export interface CanonicalSafetyGradeRow {
  id: string;
  symbol: string;
  grade: string;
  score: number | null;
  ratingStatus?: DigestV9SafetyCoin["ratingStatus"];
  partialEvidence?: DigestV9SafetyCoin["partialEvidence"];
  pillars: DigestV9SafetyCoin["pillars"];
  reasonCodes: string[];
  caps: DigestV9SafetyCap[];
  bindingCap: DigestV9SafetyCap | null;
}

export interface CollectorContext {
  db: D1Database;
  evidence?: DigestEvidence;
  trackedStablecoinAssets: StablecoinData[];
  trackedStablecoinIds: ReadonlySet<string>;
  coreAggregateStablecoinAssets: StablecoinData[];
  coreAggregateStablecoinIds: ReadonlySet<string>;
  stablecoinAssetById: Map<string, StablecoinData>;
  mcapById: Map<string, number>;
  stablecoinsCacheIsFresh: boolean;
  nowSec: number;
  todayTs: number;
  yesterdayTs: number;
}

export interface CollectorResult<T> {
  value: T;
  degradedReasons: string[];
  /**
   * Soft findings: the collector ran, but an input was absent or imperfect.
   * They are named in the persisted digest quality record without marking the
   * run degraded, which stays reserved for work that did not happen.
   */
  qualityReasons?: string[];
}

export interface SafetyScoresResult {
  safetyScores: DigestInputData["safetyScores"];
  safetyGrades: CanonicalSafetyGradeRow[] | undefined;
  safetyIdentity: SafetyScoreV9PublicationIdentity | undefined;
  safetyContext: DigestSafetyContext;
}

export function collectorResult<T>(
  value: T,
  degradedReasons: readonly string[] = [],
  qualityReasons: readonly string[] = [],
): CollectorResult<T> {
  return {
    value,
    degradedReasons: [...degradedReasons],
    ...(qualityReasons.length > 0 ? { qualityReasons: [...qualityReasons] } : {}),
  };
}

export function collectorOk<T>(value: T): CollectorResult<T> {
  return collectorResult(value);
}

export function collectorDegraded<T>(value: T, ...degradedReasons: string[]): CollectorResult<T> {
  return collectorResult(value, degradedReasons);
}

export function logCollectorParseFailure(
  collector: string,
  field: string,
  error: unknown,
  context: Record<string, string | number | undefined> = {},
): void {
  const contextLabel = Object.entries(context)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");

  logWorkerEventArgs("handler", "warn",
    `[daily-digest] Malformed persisted JSON in ${collector}:${field}${contextLabel ? ` (${contextLabel})` : ""}`,
    error,
  );
}

/** Daily editions a full weekly rollup window is expected to observe. */
export const WEEKLY_ROLLUP_EXPECTED_DAYS = 7;

export interface RollupSummary {
  mcapEnd: number | null;
  psiMid: number;
  psiDominantBand: string;
  /**
   * Cross-day sums. Null below full coverage: a total labelled "this week"
   * must not be the sum of however many editions happened to be readable.
   */
  activeDepegObs: number | null;
  uniqueDepegSignals: number | null;
  blacklistEvents: number | null;
  blacklistUsd: number | null;
  blacklistUnpricedEvents: number | null;
  unavailableReasons: Partial<Record<"mcapEnd" | "activeDepegObs" | "uniqueDepegSignals" | "blacklistEvents" | "blacklistUsd" | "gradeTransitions", string[]>>;
  gradeTransitions: number | null;
  gaugeMid: number | null;
  days: number;
  expectedDays: number;
}

/**
 * Build a stable key for a depeg signal so weekly aggregation can dedup the
 * same incident observed across multiple daily editions. Prefers `startedAt`
 * (server-side incident timestamp) when present and falls back to the
 * symbol/direction/bps tuple otherwise.
 */
function depegSignalKey(
  depeg: {
    stablecoinId?: string;
    symbol: string;
    direction?: "above" | "below";
    startedAt?: number;
    bps?: number;
    peakBps?: number;
  },
  kind: "active" | "resolved",
): string {
  if (depeg.startedAt != null) {
    return `${depeg.stablecoinId ?? depeg.symbol}:${depeg.startedAt}:${kind}`;
  }
  const bps = kind === "active" ? depeg.bps : depeg.peakBps;
  return `${depeg.symbol}:${depeg.direction ?? ""}:${bps}:${kind}`;
}

/**
 * Roll up the per-day digest inputs the weekly recap consumes into the
 * scalar aggregates used for both the current-week summary block and the
 * week-over-week delta computation. Mirrors the fields previously produced
 * inline in `weekly-recap.ts` so prior- and current-week paths share one
 * implementation.
 */
export function rollupDigestInputs(
  inputs: DigestInputData[],
  expectedDays: number = WEEKLY_ROLLUP_EXPECTED_DAYS,
): RollupSummary {
  const coreInputs = inputs.filter((input) => input.aggregateUniverse === "core-stablecoins-v1");
  const aggregateInputs = coreInputs.length > 0 ? coreInputs : inputs;
  const psiScores = aggregateInputs.map((d) => d.stabilityIndex?.score).filter((s): s is number => s != null);
  const latestInput = aggregateInputs[aggregateInputs.length - 1];
  const mcapEnd = latestInput?.supplyCoverage?.complete === true && Number.isFinite(latestInput.totalMcapUsd)
    ? latestInput.totalMcapUsd
    : null;
  const psiBands = aggregateInputs.map((d) => d.stabilityIndex?.band).filter((b): b is string => b != null);
  const bandFreq = new Map<string, number>();
  for (const b of psiBands) bandFreq.set(b, (bandFreq.get(b) ?? 0) + 1);
  const psiDominantBand = [...bandFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "BEDROCK";
  const gauges = aggregateInputs.map((d) => d.mintBurnFlows?.gaugeScore).filter((g): g is number => g != null);
  const depegKeys = new Set<string>();
  for (const input of aggregateInputs) {
    for (const depeg of input.topDepegs ?? []) {
      depegKeys.add(depegSignalKey(depeg, "active"));
    }
    for (const depeg of input.resolvedDepegs ?? []) {
      depegKeys.add(depegSignalKey(depeg, "resolved"));
    }
  }
  const complete = aggregateInputs.length >= expectedDays;
  const unavailableReasons: RollupSummary["unavailableReasons"] = {};
  const observed = (metric: keyof RollupSummary["unavailableReasons"], sourceKeys: string[], missing: (input: DigestInputData) => boolean = () => false): boolean => {
    const reasons = new Set<string>();
    if (!complete) reasons.add("daily-editions-incomplete");
    for (const input of aggregateInputs) {
      for (const source of input.degradedSources ?? []) {
        if (sourceKeys.some((key) => source === key || source.startsWith(`${key}:`))) reasons.add(source);
      }
      if (missing(input)) reasons.add(`${metric}-observation-missing`);
    }
    if (reasons.size > 0) unavailableReasons[metric] = [...reasons];
    return reasons.size === 0;
  };
  const activeObserved = observed("activeDepegObs", ["active-depegs-query"]);
  const signalsObserved = observed("uniqueDepegSignals", ["active-depegs-query", "resolved-depegs-query"]);
  // Legacy editions omitted sub-threshold activity entirely. Their missing
  // accounting cannot establish an observed zero for a weekly total.
  const blacklistObserved = observed("blacklistEvents", ["blacklist-activity-query"], (input) => input.blacklistActivity == null);
  const blacklistUsdObserved = observed("blacklistUsd", ["blacklist-activity-query"], (input) => input.blacklistActivity == null);
  const gradesObserved = observed("gradeTransitions", ["grade-transitions-query", "safety-canonical-snapshot"]);
  if (mcapEnd == null) unavailableReasons.mcapEnd = ["supply-coverage-incomplete"];
  return {
    mcapEnd,
    psiMid: psiScores.length > 0 ? psiScores.reduce((s, v) => s + v, 0) / psiScores.length : 0,
    psiDominantBand,
    activeDepegObs: activeObserved ? aggregateInputs.reduce((sum, d) => sum + d.activeDepegCount, 0) : null,
    uniqueDepegSignals: signalsObserved ? depegKeys.size : null,
    blacklistEvents: blacklistObserved ? aggregateInputs.reduce((s, d) => s + d.blacklistActivity!.eventCount, 0) : null,
    blacklistUsd: blacklistUsdObserved ? aggregateInputs.reduce((s, d) => s + d.blacklistActivity!.totalAmountUsd, 0) : null,
    blacklistUnpricedEvents: blacklistObserved ? aggregateInputs.reduce((s, d) => s + (d.blacklistActivity!.unpricedEventCount ?? 0), 0) : null,
    unavailableReasons,
    gradeTransitions: gradesObserved ? aggregateInputs.reduce((s, d) => s + (d.gradeTransitions?.length ?? 0), 0) : null,
    gaugeMid: gauges.length >= 3 ? gauges.reduce((s, v) => s + v, 0) / gauges.length : null,
    days: aggregateInputs.length,
    expectedDays,
  };
}
