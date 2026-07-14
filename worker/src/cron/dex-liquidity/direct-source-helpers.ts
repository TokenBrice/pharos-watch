import { buildPoolIdentity, type PoolIdentity } from "./pool-identity";
import { buildChainAddressKey } from "./token-resolution";
import type { DexApiPool } from "../../lib/dex-api-common";

export function normalizeFeeRateFromBps(feeBps: number | null | undefined): number | null {
  if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0) return null;
  return feeBps / 10_000;
}

export function classifyClPoolType(
  protocol: "pancakeswap" | "aerodrome-slipstream" | "velodrome-slipstream",
  feeBps: number | null | undefined,
): string {
  const normalizedFeeBps = feeBps != null && Number.isFinite(feeBps) ? feeBps : 500;
  const prefix = protocol === "pancakeswap" ? "pancakeswap-v3" : protocol;
  if (normalizedFeeBps <= 1) return `${prefix}-1bp`;
  if (normalizedFeeBps <= 5) return `${prefix}-5bp`;
  // PancakeSwap V3 uses distinct 25bp and 100bp tiers. Slipstream pool_fee units
  // are unverified (A6 deferred), so Slipstream stays on the legacy 30bp bucket.
  if (protocol === "pancakeswap") {
    if (normalizedFeeBps <= 25) return `${prefix}-25bp`;
    if (normalizedFeeBps <= 30) return `${prefix}-30bp`;
    return `${prefix}-100bp`;
  }
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
