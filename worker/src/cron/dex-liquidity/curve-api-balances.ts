import { parseStrictFiniteDecimal } from "./direct-api-json";
import type { CurvePool } from "./types";

/** A missing raw balance or USD price cannot contribute an observed zero. */
export function curveApiCoinBalance(coin: CurvePool["coins"][number]) {
  const raw = parseStrictFiniteDecimal(coin.poolBalance);
  const decimals = parseStrictFiniteDecimal(coin.decimals);
  const usdBalance =
    raw != null && raw >= 0 &&
    decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 &&
    Number.isFinite(coin.usdPrice) && coin.usdPrice > 0
      ? (raw / 10 ** decimals) * coin.usdPrice
      : null;
  return { coin, raw, decimals, usdBalance };
}

export function curveApiTotalBalance(coins: readonly ReturnType<typeof curveApiCoinBalance>[]): number {
  return coins.reduce((sum, { usdBalance }) => sum + (usdBalance ?? Number.NaN), 0);
}
