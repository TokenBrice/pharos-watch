import { buildPoolIdentity, type PoolIdentity } from "./pool-identity";
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

export function buildDirectApiPoolIdentity(pool: DexApiPool): PoolIdentity {
  return buildPoolIdentity({
    chain: pool.chain,
    protocol: pool.source,
    poolAddressOrId: pool.poolAddress,
    tokenAddresses: pool.tokens.map((token) => token.address),
    poolType: pool.poolType,
    feeTierBps: deriveDirectApiFeeTierBps(pool),
    isStable: pool.poolType.includes("stable") || pool.poolType.includes("fluid"),
  });
}
