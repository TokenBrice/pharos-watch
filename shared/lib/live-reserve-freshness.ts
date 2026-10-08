import type { ReserveFreshnessView } from "../types/reserve-input";

/** Upstream clocks may lead Worker time; Worker fetch clocks have no allowance. */
export const MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 10 * 60;

/** Coin policy may tighten, but never widen, the adapter's source-age budget. */
export function resolveLiveReserveSourceAgeBudget(
  scoringMaxSourceAgeSec: number | null | undefined,
  adapterMaxSourceAgeSec: number | null | undefined,
  fallbackSec: number,
): Pick<ReserveFreshnessView, "sourceAgeBudgetSec" | "sourceAgeBudgetCap"> & { sourceAgeBudgetSec: number } {
  const cappedAge = Math.min(scoringMaxSourceAgeSec ?? Infinity, adapterMaxSourceAgeSec ?? Infinity);
  if (!Number.isFinite(cappedAge)) return { sourceAgeBudgetSec: fallbackSec, sourceAgeBudgetCap: "fetch-budget" };
  return { sourceAgeBudgetSec: cappedAge, sourceAgeBudgetCap: cappedAge === scoringMaxSourceAgeSec ? "scoring" : "adapter" };
}
