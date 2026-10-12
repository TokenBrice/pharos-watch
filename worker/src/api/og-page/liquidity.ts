import { formatCurrency } from "@shared/lib/format";
import { DEX_GLOBAL_KEY, DexLiquidityMapSchema } from "@shared/types/market";
import { handleDexLiquidity } from "../dex-liquidity";
import { freshnessReason, readOwnerJson, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/** `/liquidity` hero: "Total DEX TVL", the `/api/dex-liquidity` global row's `totalTvlUsd`. */
export const loadLiquidityOgPage: OgPageLoader = async (db, nowSec) => {
  const body = await readOwnerJson(await handleDexLiquidity(db), DexLiquidityMapSchema);
  if (!body) return unavailable("owner-error");
  const global = body[DEX_GLOBAL_KEY];
  if (!global) return unavailable("figure-null");
  if (global.unavailableReason != null) return unavailable("incomplete-coverage");
  const budgetSec = OG_SOURCE_BUDGET_SEC.dexLiquidity;
  const stale = freshnessReason(nowSec, global.updatedAt, budgetSec);
  if (stale) return unavailable(stale);
  return {
    kind: "ok",
    hero: formatCurrency(global.totalTvlUsd),
    context: "total value locked in tracked stablecoin DEX pools",
    support: [],
    asOfSec: global.updatedAt,
    budgetSec,
    generation: `dex-liquidity:${global.updatedAt}`,
  };
};
