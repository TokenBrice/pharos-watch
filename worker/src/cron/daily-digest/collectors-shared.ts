import { logWorkerEventArgs } from "../../lib/structured-log";
import type {
  DigestInputData,
  DigestSafetyContext,
  DigestV9SafetyCap,
  DigestV9SafetyCoin,
} from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";

export interface CanonicalSafetyGradeRow {
  id: string;
  symbol: string;
  grade: string;
  score: number | null;
  pillars: DigestV9SafetyCoin["pillars"];
  reasonCodes: string[];
  caps: DigestV9SafetyCap[];
  bindingCap: DigestV9SafetyCap | null;
}

export interface CollectorContext {
  db: D1Database;
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
  degradedReason?: string;
}

export interface SafetyScoresResult {
  safetyScores: DigestInputData["safetyScores"];
  safetyGrades: CanonicalSafetyGradeRow[] | undefined;
  safetyIdentity: SafetyScoreV9PublicationIdentity | undefined;
  safetyContext: DigestSafetyContext;
}

export function collectorOk<T>(value: T): CollectorResult<T> {
  return { value };
}

export function collectorDegraded<T>(value: T, degradedReason: string): CollectorResult<T> {
  return { value, degradedReason };
}

export function markCollectorDegraded(degradedReasons: string[] | undefined, degradedReason: string): void {
  if (!degradedReasons || degradedReasons.includes(degradedReason)) {
    return;
  }
  degradedReasons.push(degradedReason);
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

export interface RollupSummary {
  mcapEnd: number;
  psiMid: number;
  psiDominantBand: string;
  activeDepegObs: number;
  uniqueDepegSignals: number;
  blacklistEvents: number;
  blacklistUsd: number;
  gradeTransitions: number;
  gaugeMid: number | null;
  days: number;
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
export function rollupDigestInputs(inputs: DigestInputData[]): RollupSummary {
  const coreInputs = inputs.filter((input) => input.aggregateUniverse === "core-stablecoins-v1");
  const aggregateInputs = coreInputs.length > 0 ? coreInputs : inputs;
  const psiScores = aggregateInputs.map((d) => d.stabilityIndex?.score).filter((s): s is number => s != null);
  const mcaps = aggregateInputs.map((d) => d.totalMcapUsd);
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
  return {
    mcapEnd: mcaps[mcaps.length - 1] ?? 0,
    psiMid: psiScores.length > 0 ? psiScores.reduce((s, v) => s + v, 0) / psiScores.length : 0,
    psiDominantBand,
    activeDepegObs: aggregateInputs.reduce((sum, d) => sum + d.activeDepegCount, 0),
    uniqueDepegSignals: depegKeys.size,
    blacklistEvents: aggregateInputs.reduce((s, d) => s + (d.blacklistActivity?.eventCount ?? 0), 0),
    blacklistUsd: aggregateInputs.reduce((s, d) => s + (d.blacklistActivity?.totalAmountUsd ?? 0), 0),
    gradeTransitions: aggregateInputs.reduce((s, d) => s + (d.gradeTransitions?.length ?? 0), 0),
    gaugeMid: gauges.length >= 3 ? gauges.reduce((s, v) => s + v, 0) / gauges.length : null,
    days: aggregateInputs.length,
  };
}
