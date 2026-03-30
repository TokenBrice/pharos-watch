import type { DigestInputData } from "@shared/types/digest";
import type { StablecoinData } from "@shared/types/market";
import type { SafetyGradeRow } from "../../lib/safety-scores";

export interface CollectorContext {
  db: D1Database;
  trackedStablecoinAssets: StablecoinData[];
  mcapById: Map<string, number>;
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
  safetyGrades: SafetyGradeRow[] | undefined;
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

  console.warn(
    `[daily-digest] Malformed persisted JSON in ${collector}:${field}${contextLabel ? ` (${contextLabel})` : ""}`,
    error,
  );
}
