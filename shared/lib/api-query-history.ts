import { YIELD_HISTORY_MAX_DAYS } from "./yield-history-policy";

/** A bounded day window, or every retained daily supply observation. */
export type SupplyHistoryWindow = number | "all";

const REJECTING_HISTORY_RANGE = { minDays: 1, rangePolicy: "reject" } as const;

export const STABLECOIN_HISTORY_QUERY_CONTRACTS = {
  dexLiquidity: { ...REJECTING_HISTORY_RANGE, defaultDays: 90, maxDays: 365 },
  supply: { ...REJECTING_HISTORY_RANGE, defaultDays: 365, maxDays: 5000, allowAllRange: true },
  yield: { ...REJECTING_HISTORY_RANGE, defaultDays: 90, maxDays: YIELD_HISTORY_MAX_DAYS },
  safetyScore: { ...REJECTING_HISTORY_RANGE, defaultDays: 365, maxDays: 3650 },
} as const;
