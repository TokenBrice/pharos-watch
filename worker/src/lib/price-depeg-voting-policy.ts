

/** Minimum per-pool TVL for DEX pool challenge and pool-level depeg confirmation */
export const POOL_CHALLENGE_MIN_TVL = 100_000; // $100K

/** Number of qualifying pools that must agree to promote a pending depeg via pool-only confirmation. */
const POOL_CHALLENGE_CONFIRM_MIN = 2;

/** Single-pool TVL above which pool-only confirmation can promote with a single pool. */
export const POOL_CHALLENGE_HIGH_TVL_USD = 5_000_000; // $5M

/**
 * One authority for the diverging-vs-corroborating protocol-group precedence rule
 * shared by price hardening (`selectReplacementProtocolGroups` and its confidence
 * downgrade), pending-depeg pool confirmation, and the primary-recovery pool veto.
 *
 * 2026-09-24 (vchf-vnx): two dormant protocols whose last trade is months old and
 * whose provider-reported reserves cannot carry a decision — the Celo Uniswap v3
 * VCHF/USD₮ pool (last trade 2026-03-15, provider-reported $4.7M reserve against
 * ~$141 on-chain, 24h volume 0) and the ICP kongswap VCHF/ICP pool (24h volume 0)
 * — both replaced a four-protocol consensus that matched the ECB CHF rate and
 * then vetoed its recovery. A diverging set must therefore both reach
 * `POOL_CHALLENGE_CONFIRM_MIN` independent groups and be at least as numerous as
 * the groups whose medians corroborate the current/recovered price before it can
 * carry a depeg decision. Callers keep their own high-TVL directional carve-outs.
 *
 * The bar is `POOL_CHALLENGE_CONFIRM_MIN` (2), which both lanes share: a future
 * depeg-lane retune of that constant also moves the pricing replacement bar.
 */
export function divergingProtocolGroupsOutvote(params: {
  divergingCount: number;
  corroboratingCount: number;
}): boolean {
  return params.divergingCount >= POOL_CHALLENGE_CONFIRM_MIN &&
    params.divergingCount >= params.corroboratingCount;
}

/**
 * The complement of `divergingProtocolGroupsOutvote`: at least
 * `POOL_CHALLENGE_CONFIRM_MIN` independent groups corroborate the current price
 * and strictly outnumber the diverging set, so the losing diverging minority may
 * neither replace the price nor downgrade its confidence tier — that tier is what
 * the depeg recovery gate consumes. A tie or a diverging majority is not outvoted
 * and still downgrades/replaces exactly as before. Any real replacement still
 * downgrades, because the replacement decision itself is unchanged.
 */
export function corroboratingProtocolGroupsOutvote(params: {
  divergingCount: number;
  corroboratingCount: number;
}): boolean {
  return params.corroboratingCount >= POOL_CHALLENGE_CONFIRM_MIN &&
    params.corroboratingCount > params.divergingCount;
}

