import { QUALITY_MULTIPLIERS } from "../../lib/dex-constants";
import type { CgPool, CgPoolAttributes } from "../../lib/coingecko-onchain";
import { parseCgPoolVolume } from "../../lib/coingecko-onchain";
import type { ParsedPool } from "./crawl-helpers";
import { getGtDexQuality } from "./pool-helpers";

export interface CgPoolClassification {
  qualityMultiplier: number;
  poolType: string;
  feePercentage: number | null;
  lockedLiquidityPct: number | null;
  balanceRatio: number | null;
}

function parseOptionalFiniteNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function inferCgBalanceRatio(
  baseTokenPriceUsd: number,
  quoteTokenPriceUsd: number,
): number | null {
  if (baseTokenPriceUsd <= 0 || quoteTokenPriceUsd <= 0) {
    return null;
  }

  const ratio = Math.min(baseTokenPriceUsd, quoteTokenPriceUsd) /
    Math.max(baseTokenPriceUsd, quoteTokenPriceUsd);

  return ratio > 0.5 ? ratio : null;
}

export function parseCgPool(pool: CgPool): ParsedPool | null {
  const attrs = pool.attributes;
  const dexId = pool.relationships.dex.data.id;
  const poolAddress = attrs.address?.toLowerCase();

  if (!dexId || !poolAddress) {
    return null;
  }

  return {
    dexId,
    poolAddress,
    tvlUsd: Number.parseFloat(attrs.reserve_in_usd ?? ""),
    volume24hUsd: parseCgPoolVolume(attrs),
    baseTokenAddress: pool.relationships.base_token.data.id.split("_").pop()?.toLowerCase() ?? "",
    quoteTokenAddress: pool.relationships.quote_token.data.id.split("_").pop()?.toLowerCase() ?? "",
    baseTokenPriceUsd: Number.parseFloat(attrs.base_token_price_usd ?? ""),
    quoteTokenPriceUsd: Number.parseFloat(attrs.quote_token_price_usd ?? ""),
    createdAt: attrs.pool_created_at,
    poolName: attrs.name,
  };
}

export function classifyCgPool(
  parsed: Pick<ParsedPool, "dexId" | "baseTokenPriceUsd" | "quoteTokenPriceUsd">,
  rawAttrs: Pick<CgPoolAttributes, "pool_fee_percentage" | "locked_liquidity_percentage">,
): CgPoolClassification {
  const feePercentage = parseOptionalFiniteNumber(rawAttrs.pool_fee_percentage);
  const lockedLiquidityPct = parseOptionalFiniteNumber(rawAttrs.locked_liquidity_percentage);

  if (feePercentage != null) {
    if (feePercentage <= 0.01) {
      return {
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-1bp"]!,
        poolType: "cg-cl-1bp",
        feePercentage,
        lockedLiquidityPct,
        balanceRatio: inferCgBalanceRatio(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd),
      };
    }

    if (feePercentage <= 0.05) {
      return {
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!,
        poolType: "cg-cl-5bp",
        feePercentage,
        lockedLiquidityPct,
        balanceRatio: inferCgBalanceRatio(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd),
      };
    }

    if (feePercentage <= 0.30) {
      return {
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!,
        poolType: "cg-cl-30bp",
        feePercentage,
        lockedLiquidityPct,
        balanceRatio: inferCgBalanceRatio(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd),
      };
    }

    return {
      qualityMultiplier: QUALITY_MULTIPLIERS["generic"]!,
      poolType: "cg-wide-fee",
      feePercentage,
      lockedLiquidityPct,
      balanceRatio: inferCgBalanceRatio(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd),
    };
  }

  return {
    qualityMultiplier: getGtDexQuality(parsed.dexId),
    poolType: parsed.dexId.includes("v3") || parsed.dexId.includes("v4")
      ? "cg-concentrated"
      : parsed.dexId.includes("stable")
        ? "cg-stable-amm"
        : "cg-amm",
    feePercentage: null,
    lockedLiquidityPct,
    balanceRatio: inferCgBalanceRatio(parsed.baseTokenPriceUsd, parsed.quoteTokenPriceUsd),
  };
}
