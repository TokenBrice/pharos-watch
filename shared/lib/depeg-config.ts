// 100bps (1%) minimum deviation to consider a depeg event for USD-pegged stablecoins.
// Below this, price movement is within normal market noise (bid-ask spreads,
// CEX-DEX arb latency). Calibrated against 2023-2024 false-positive rate.
export const DEPEG_THRESHOLD_BPS = 100;

// 150bps for non-USD pegs (FX, commodity). Higher threshold because FX pairs
// have wider bid-ask spreads, commodity oracles update less frequently,
// and cross-currency pricing adds noise from FX rate staleness.
export const DEPEG_THRESHOLD_BPS_NON_USD = 150;
