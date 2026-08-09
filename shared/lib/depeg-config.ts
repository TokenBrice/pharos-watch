// 100bps (1%) minimum deviation to consider a depeg event for USD-pegged stablecoins.
// Below this, price movement is within normal market noise (bid-ask spreads,
// CEX-DEX arb latency). Calibrated against 2023-2024 false-positive rate.
export const DEPEG_THRESHOLD_BPS = 100;

// 150bps for non-USD pegs (FX, commodity). Higher threshold because FX pairs
// have wider bid-ask spreads, commodity oracles update less frequently,
// and cross-currency pricing adds noise from FX rate staleness.
export const DEPEG_THRESHOLD_BPS_NON_USD = 150;

// A live event only recovers after moving materially back inside its trigger
// threshold. This deadband prevents boundary noise from splitting one incident.
export const DEPEG_RECOVERY_THRESHOLD_RATIO = 0.5;

export const DEX_FRESHNESS_SEC = 2100;
export const DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD = 1_000_000;
export const DEPEG_EVENT_MIN_SUPPLY_USD = 1_000_000;
export const DEPEG_DEX_PROTOCOL_CORROBORATION_MIN = 2;
export const DEPEG_CONFIRMATION_SUPPLY_THRESHOLD = 1_000_000_000;
export const DEPEG_PRIMARY_PRICE_MAX_AGE_SEC = 1800;
export const DEPEG_EXTREME_MOVE_BPS = 5000;

/**
 * Named severity vocabulary for absolute depeg deviation (bps).
 *
 * `offPeg` is the USD trigger threshold; `severe` is the 25% band that gates the
 * redemption lane and the digest's critical-risk copy; `extreme` is the 50% band.
 *
 * ADR-19 note: the V9 methodology policy JSON stays the scoring owner — its
 * `semantic.formula.activeDepegCaps` entry carries its own 2500 and is never
 * read from here. `shared/lib/__tests__/exit-policy-constants-pin.test.ts`
 * asserts the two agree so drift is a CI failure rather than a silent divergence.
 */
export const DEPEG_SEVERITY_BPS = {
  offPeg: DEPEG_THRESHOLD_BPS,
  severe: 2500,
  extreme: DEPEG_EXTREME_MOVE_BPS,
} as const;
export const DEPEG_PENDING_MIN_AGE_SEC = 900;
export const DEPEG_PENDING_EXPIRY_SEC = 2700;
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 1;
