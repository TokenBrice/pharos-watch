import type { PegCurrency } from "../types/core";

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

/** One unit of floating-point precision at par, expressed in basis points. */
export const PAR_ROUNDOFF_BPS = Number.EPSILON * 10_000;

export const DEX_FRESHNESS_SEC = 75 * 60;
export const DEX_PROTOCOL_SOURCE_FRESHNESS_SEC = 35 * 60;
export const DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD = 1_000_000;
// Event creation only: never withhold an observed current price deviation by supply.
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
 * ADR-19 note: the V9 methodology policy JSON stays the scoring source — its
 * `semantic.formula.activeDepegCaps` entry carries its own 2500 and is never
 * read from here. This vocabulary serves depeg/redemption views; it is not a
 * policy mirror and whole-policy parity is not a contract.
 */
export const DEPEG_SEVERITY_BPS = {
  offPeg: DEPEG_THRESHOLD_BPS,
  severe: 2500,
  extreme: DEPEG_EXTREME_MOVE_BPS,
} as const;
// Weekend gaps use the observed maximum plus 25%. Fewer than 300 closures retain 2,500 bps.
export const REFERENCE_CLOSURE_HOLD_BANDS_BPS: Record<PegCurrency, { weekend: number; extended: number }> = {
  USD: { weekend: 2500, extended: 2500 },
  EUR: { weekend: 300, extended: 2500 },
  GBP: { weekend: 500, extended: 2500 },
  CHF: { weekend: 425, extended: 2500 },
  BRL: { weekend: 1850, extended: 2500 },
  RUB: { weekend: 2500, extended: 2500 },
  JPY: { weekend: 550, extended: 2500 },
  KRW: { weekend: 750, extended: 2500 },
  IDR: { weekend: 1100, extended: 2500 },
  INR: { weekend: 400, extended: 2500 },
  MYR: { weekend: 325, extended: 2500 },
  SGD: { weekend: 275, extended: 2500 },
  HKD: { weekend: 200, extended: 2500 },
  TRY: { weekend: 1650, extended: 2500 },
  AUD: { weekend: 525, extended: 2500 },
  ZAR: { weekend: 675, extended: 2500 },
  CAD: { weekend: 425, extended: 2500 },
  CNY: { weekend: 225, extended: 2500 },
  CNH: { weekend: 2500, extended: 2500 },
  PHP: { weekend: 800, extended: 2500 },
  MXN: { weekend: 975, extended: 2500 },
  VND: { weekend: 2500, extended: 2500 },
  UAH: { weekend: 2500, extended: 2500 },
  ARS: { weekend: 2500, extended: 2500 },
  KGS: { weekend: 2500, extended: 2500 },
  NGN: { weekend: 2500, extended: 2500 },
  XOF: { weekend: 2500, extended: 2500 },
  COP: { weekend: 2500, extended: 2500 },
  CLP: { weekend: 2500, extended: 2500 },
  GHS: { weekend: 2500, extended: 2500 },
  KES: { weekend: 2500, extended: 2500 },
  PEN: { weekend: 2500, extended: 2500 },
  CZK: { weekend: 400, extended: 2500 },
  PLN: { weekend: 600, extended: 2500 },
  AED: { weekend: 2500, extended: 2500 },
  // Retained at the uncalibrated 2,500 bps fallback until NZD receives a formal L18 closure calibration.
  NZD: { weekend: 2500, extended: 2500 },
  GOLD: { weekend: 1200, extended: 2500 },
  SILVER: { weekend: 2450, extended: 2500 },
  VAR: { weekend: 2500, extended: 2500 },
  OTHER: { weekend: 2500, extended: 2500 },
};
export const DEPEG_PENDING_MIN_AGE_SEC = 900;
export const DEPEG_PENDING_EXPIRY_SEC = 2700;
// Same-direction primary evidence or an unavailable/circuit-open confirmer may
// keep a candidate pending to the extended limit; extreme moves get the final one.
export const DEPEG_PENDING_EXTENDED_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 3;
export const DEPEG_PENDING_SEVERE_EXPIRY_SEC = DEPEG_PENDING_EXPIRY_SEC * 4;
export const DEPEG_SECONDARY_THRESHOLD_RATIO = 1;
