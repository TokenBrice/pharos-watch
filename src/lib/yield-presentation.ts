import type { YieldPysNullReason, YieldRankChangeAttribution } from "@shared/types";
import { YIELD_RANK_CHANGE_DRIVER_LABELS } from "@/lib/yield-source-risk";

export const PYS_NULL_REASON_TEXT: Record<YieldPysNullReason, string> = {
  "apy-non-positive": "30d APY ≤ 0",
  "effective-yield-non-positive": "Effective yield ≤ 0 after benchmark",
  "scaling-invalid": "Scaling factor unavailable",
  "missing-inputs": "Missing inputs",
};

function formatSignedPysDelta(delta: number): string {
  const rounded = Math.abs(delta) >= 10 ? delta.toFixed(1) : delta.toFixed(2);
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "+";
  return `${sign}${rounded} PYS`;
}

export interface YieldRankChangeChipDisplay {
  arrow: string;
  colorClass: string;
  signedRank: string;
  short: string;
  long: string;
  pysDeltaLabel: string | null;
}

// WHY: returns null when the delta is too small to be meaningful (gates leaderboard
// chip render). |pysDelta| >= 1 mirrors the published rank-attribution threshold.
export function buildRankChangeChipDisplay(
  attribution: YieldRankChangeAttribution | null | undefined,
): YieldRankChangeChipDisplay | null {
  if (!attribution) return null;
  const { rankDelta, pysDelta, primaryDriver } = attribution;
  if (rankDelta == null || primaryDriver == null || Math.abs(pysDelta ?? 0) < 1) return null;
  const driver = YIELD_RANK_CHANGE_DRIVER_LABELS[primaryDriver];
  if (!driver) return null;
  const arrow = rankDelta < 0 ? "▲" : rankDelta > 0 ? "▼" : "■";
  const colorClass =
    rankDelta < 0
      ? "text-emerald-700 dark:text-emerald-400"
      : rankDelta > 0
        ? "text-red-700 dark:text-red-400"
        : "text-muted-foreground";
  const signedRank = rankDelta < 0 ? `+${Math.abs(rankDelta)}` : rankDelta > 0 ? `-${rankDelta}` : "0";
  return {
    arrow,
    colorClass,
    signedRank,
    short: driver.short,
    long: driver.long,
    pysDeltaLabel: pysDelta != null ? formatSignedPysDelta(pysDelta) : null,
  };
}
