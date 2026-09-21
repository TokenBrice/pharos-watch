import { buildPoolIdentity, type PoolIdentity } from "./pool-identity";
import { buildChainAddressKey } from "./token-resolution";
import type { DexApiPool } from "../../lib/dex-api-common";

/**
 * Bucket published when a concentrated-liquidity source cannot decode its own
 * fee tier. It states no basis-point claim, so it never contradicts the
 * `feeRate: null` published beside it, and it falls through to the generic
 * quality multiplier instead of a fabricated tier.
 */
export const CL_UNKNOWN_FEE_BUCKET = "unknown-fee";

export function normalizeFeeRateFromBps(feeBps: number | null | undefined): number | null {
  if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0) return null;
  return feeBps / 10_000;
}

export function classifyClPoolType(
  protocol: "pancakeswap" | "aerodrome-slipstream" | "velodrome-slipstream",
  feeBps: number | null | undefined,
): string {
  const prefix = protocol === "pancakeswap" ? "pancakeswap-v3" : protocol;
  // A missing or malformed fee is not an observation: publish the neutral
  // bucket rather than defaulting onto either end of the tier ladder.
  if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0) {
    return `${prefix}-${CL_UNKNOWN_FEE_BUCKET}`;
  }
  if (feeBps <= 1) return `${prefix}-1bp`;
  if (feeBps <= 5) return `${prefix}-5bp`;
  // PancakeSwap V3 uses distinct 25bp and 100bp tiers. Slipstream pool_fee
  // values are basis points with reviewed 1bp, 5bp, 30bp, and 100bp tiers.
  if (protocol === "pancakeswap") {
    if (feeBps <= 25) return `${prefix}-25bp`;
    if (feeBps <= 30) return `${prefix}-30bp`;
    return `${prefix}-100bp`;
  }
  if (feeBps > 30) return `${prefix}-100bp`;
  return `${prefix}-30bp`;
}

function deriveDirectApiFeeTierBps(pool: DexApiPool): number | null {
  if (pool.feeRate == null || !Number.isFinite(pool.feeRate) || pool.feeRate <= 0) return null;
  return Math.round(pool.feeRate * 10_000 * 100) / 100;
}

export function buildDirectApiPoolIdentity(
  pool: DexApiPool,
  chainAddressToId?: Map<string, string>,
): PoolIdentity {
  // DeFiLlama rows mark all-stablecoin pairs stable (`pool.stablecoin`), while
  // direct sources only encode stability in the pool type. Without the same
  // tracked-pair hint the stability buckets diverge and the cross-source
  // dedupe never collapses the duplicate (observed live: DL raydium-amm
  // USDS-USDC surviving next to the identical direct Raydium pool).
  const typeImpliesStable = pool.poolType.includes("stable") || pool.poolType.includes("fluid");
  const allTrackedStablePair =
    chainAddressToId != null &&
    pool.tokens.length >= 2 &&
    pool.tokens.every((token) => chainAddressToId.has(buildChainAddressKey(pool.chain, token.address)));
  return buildPoolIdentity({
    chain: pool.chain,
    protocol: pool.source,
    poolAddressOrId: pool.poolAddress,
    tokenAddresses: pool.tokens.map((token) => token.address),
    poolType: pool.poolType,
    feeTierBps: deriveDirectApiFeeTierBps(pool),
    isStable: typeImpliesStable || allTrackedStablePair,
  });
}
