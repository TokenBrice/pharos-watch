/** Operator diagnostics only; never a tolerance on the native residual. */
export const MINT_BURN_RECONCILIATION_POLICY = {
  daySec: 86_400,
  retentionSec: 95 * 86_400,
  valueUsd: 10_000_000,
  supplyPercent: 2,
} as const;
