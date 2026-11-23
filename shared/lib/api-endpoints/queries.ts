/** Runtime-neutral request bounds; handlers retain their existing parsing semantics. */
export const MINT_BURN_FLOWS_HOURS_QUERY = {
  type: "int", default: 24, min: 1, max: 720, rangePolicy: "reject",
} as const;

export const NON_USD_SHARE_MIN_DAYS = 30;
export const NON_USD_SHARE_MAX_DAYS = 5000;

/** Depeg-events page bound for direct authenticated site-api callers (release sync) only. */
export const DEPEG_EVENTS_SITE_API_MAX_LIMIT = 5000;

// Parameterless reads return the full index until it outgrows the page bound.
export const SNAPSHOT_INDEX_LIMIT_QUERY = { min: 1, max: 500, default: 500 } as const;

export const RESOLVE_MAX_CONTRACTS = 50;
export const RISK_CHECK_MAX_ASSETS = 25;
