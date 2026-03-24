import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";

const METEORA_API = "https://dlmm.datapi.meteora.ag/pools";
const PAGE_SIZE = 500;

interface MeteoraToken {
  address: string;
  symbol: string;
  decimals: number;
  price?: number | null;
}

interface MeteoraPool {
  address: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  token_x_amount: number;
  token_y_amount: number;
  current_price?: number | null;
  tvl?: number | null;
  volume?: { "24h"?: number | null } | null;
  pool_config?: { base_fee_pct?: number | null } | null;
  dynamic_fee_pct?: number | null;
  is_blacklisted?: boolean;
}

interface MeteoraResponse {
  data?: MeteoraPool[];
}

export async function fetchMeteoraPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const pools: DexApiPool[] = [];
  const errors: string[] = [];
  let page = 1;
  let successfulPages = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(`${METEORA_API}?page=${page}&limit=${PAGE_SIZE}`, {
        headers: { "User-Agent": USER_AGENT },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch (error) {
      errors.push(`page ${page} request failed: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }

    if (!res.ok) {
      errors.push(`page ${page} returned ${res.status}`);
      break;
    }

    const json = await res.json() as MeteoraResponse;
    const rows = json.data;
    if (!Array.isArray(rows)) {
      errors.push(`page ${page} returned malformed body`);
      break;
    }

    successfulPages++;
    if (rows.length === 0) break;

    let pageHasEligiblePool = false;
    for (const row of rows) {
      const tvlUsd = row.tvl ?? null;
      if (!Number.isFinite(tvlUsd) || tvlUsd == null || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) continue;
      if (row.is_blacklisted) continue;
      pageHasEligiblePool = true;

      const volume24hUsd = row.volume?.["24h"];
      const baseFeePct = row.pool_config?.base_fee_pct;
      const dynamicFeePct = row.dynamic_fee_pct;
      const feePct = [baseFeePct, dynamicFeePct]
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
        .reduce((sum, value) => sum + value, 0);

      const reserve0 = row.token_x_amount;
      const reserve1 = row.token_y_amount;
      const derivedPrice = Number.isFinite(reserve0) && reserve0 > 0 && Number.isFinite(reserve1) && reserve1 > 0
        ? reserve1 / reserve0
        : null;

      pools.push({
        source: "meteora",
        chain: "solana",
        poolAddress: row.address,
        poolType: "meteora-dlmm",
        tokens: [
          {
            address: row.token_x.address,
            symbol: row.token_x.symbol,
            decimals: row.token_x.decimals,
            priceUsd: row.token_x.price ?? null,
          },
          {
            address: row.token_y.address,
            symbol: row.token_y.symbol,
            decimals: row.token_y.decimals,
            priceUsd: row.token_y.price ?? null,
          },
        ],
        price: Number.isFinite(derivedPrice) && derivedPrice != null && derivedPrice > 0
          ? derivedPrice
          : (row.current_price != null && Number.isFinite(row.current_price) && row.current_price > 0 ? row.current_price : null),
        tvlUsd,
        volume24hUsd: volume24hUsd != null && Number.isFinite(volume24hUsd) ? volume24hUsd : 0,
        feeRate: feePct > 0 ? feePct / 100 : null,
        balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
      });
    }

    if (!pageHasEligiblePool || rows.length < PAGE_SIZE) break;
    page++;
  }

  if (pools.length > 0) {
    console.log(`[fetch-meteora] Fetched ${pools.length} pools`);
  }
  for (const error of errors) {
    console.warn("[fetch-meteora]", error);
  }

  return makeDexApiFetchResult(pools, {
    ok: successfulPages > 0,
    degraded: errors.length > 0,
    errors,
  });
}
