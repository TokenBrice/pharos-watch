import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import type { CgPool, CgPoolAttributes } from "../../lib/coingecko-onchain";
import { parseCgPoolVolume } from "../../lib/coingecko-onchain";
import type { ParsedPool } from "./crawl-helpers";
import { parseGtShapedPool } from "./geckoterminal-shared";
import { getGtDexQuality } from "./pool-normalization";

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

export function parseCgPool(pool: CgPool, chain: string): ParsedPool | null {
  // Volume and createdAt stay CG-specific: the flat Pro `h24_volume_usd` wins
  // when positive (fallback: nested `volume_usd.h24`); absent created_at → null.
  return parseGtShapedPool(
    pool,
    chain,
    parseCgPoolVolume(pool.attributes),
    pool.attributes.pool_created_at ?? null,
  );
}

export function classifyCgPool(
  parsed: Pick<ParsedPool, "dexId">,
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
        balanceRatio: null,
      };
    }

    if (feePercentage <= 0.05) {
      return {
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-5bp"]!,
        poolType: "cg-cl-5bp",
        feePercentage,
        lockedLiquidityPct,
        balanceRatio: null,
      };
    }

    if (feePercentage <= 0.3) {
      return {
        qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-30bp"]!,
        poolType: "cg-cl-30bp",
        feePercentage,
        lockedLiquidityPct,
        balanceRatio: null,
      };
    }

    return {
      qualityMultiplier: QUALITY_MULTIPLIERS["generic"]!,
      poolType: "cg-wide-fee",
      feePercentage,
      lockedLiquidityPct,
      balanceRatio: null,
    };
  }

  return {
    qualityMultiplier: getGtDexQuality(parsed.dexId),
    poolType:
      parsed.dexId.includes("v3") || parsed.dexId.includes("v4")
        ? "cg-concentrated"
        : parsed.dexId.includes("stable")
          ? "cg-stable-amm"
          : "cg-amm",
    feePercentage: null,
    lockedLiquidityPct,
    balanceRatio: null,
  };
}
