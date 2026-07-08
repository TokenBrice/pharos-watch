import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { isDexApiRecord } from "./direct-api-json";
import { runPaginatedDirectApiFetch } from "./direct-api-paginated";

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
  data?: unknown;
}

function isMeteoraToken(value: unknown): value is MeteoraToken {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    typeof value.symbol === "string" &&
    typeof value.decimals === "number" &&
    Number.isFinite(value.decimals) &&
    (value.price == null || (typeof value.price === "number" && Number.isFinite(value.price)));
}

function isMeteoraPool(value: unknown): value is MeteoraPool {
  return isDexApiRecord(value) &&
    typeof value.address === "string" &&
    isMeteoraToken(value.token_x) &&
    isMeteoraToken(value.token_y) &&
    typeof value.token_x_amount === "number" &&
    Number.isFinite(value.token_x_amount) &&
    typeof value.token_y_amount === "number" &&
    Number.isFinite(value.token_y_amount);
}

export async function fetchMeteoraPools(signal?: AbortSignal): Promise<DexApiFetchResult> {
  const malformedRowsByPage = new Map<number, number>();
  const result = await runPaginatedDirectApiFetch<DexApiPool>({
    source: "meteora",
    buildUrl: (page) => `${METEORA_API}?page=${page}&limit=${PAGE_SIZE}`,
    pageSize: PAGE_SIZE,
    signal,
    parsePage: (body, page) => {
      const json = body as MeteoraResponse;
      const rows = json.data;
      return Array.isArray(rows) ? rows : { error: `page ${page} returned malformed body` };
    },
    mapRow: (rawRow, { page }) => {
      if (!isMeteoraPool(rawRow)) {
        malformedRowsByPage.set(page, (malformedRowsByPage.get(page) ?? 0) + 1);
        return null;
      }

      const row = rawRow;
      const tvlUsd = row.tvl ?? null;
      if (!Number.isFinite(tvlUsd) || tvlUsd == null || tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) return null;
      if (row.is_blacklisted) return null;

      const volume24hUsd = row.volume?.["24h"];
      const baseFeePct = row.pool_config?.base_fee_pct;
      const dynamicFeePct = row.dynamic_fee_pct;
      const feePct = [baseFeePct, dynamicFeePct]
        .filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
        .reduce((sum, value) => sum + value, 0);

      const reserve0 = row.token_x_amount;
      const reserve1 = row.token_y_amount;
      // Meteora DLMM is concentrated liquidity — the bin reserve ratio is NOT the spot price.
      // `current_price`, token `price`, `tvl`, and `volume["24h"]` are already normalized USD
      // fields from the Meteora API; leave balances[] in native token units for balance consumers.
      const spotPrice =
        row.current_price != null && Number.isFinite(row.current_price) && row.current_price > 0
          ? row.current_price
          : null;

      return {
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
        price: spotPrice,
        tvlUsd,
        volume24hUsd: volume24hUsd != null && Number.isFinite(volume24hUsd) ? volume24hUsd : 0,
        feeRate: feePct > 0 ? feePct / 100 : null,
        balances: Number.isFinite(reserve0) && Number.isFinite(reserve1) ? [reserve0, reserve1] : null,
      };
    },
    afterPage: ({ warnings, page }) => {
      const malformedRows = malformedRowsByPage.get(page) ?? 0;
      if (malformedRows > 0) {
        warnings.push(`page ${page} skipped ${malformedRows} malformed pool rows`);
      }
    },
  });

  if (result.rows.length > 0) {
    console.log(`[fetch-meteora] Fetched ${result.rows.length} pools`);
  }
  for (const error of result.errors) {
    console.warn("[fetch-meteora]", error);
  }

  return makeDexApiFetchResult(result.rows, {
    ok: result.successfulPages > 0,
    degraded: result.errors.length > 0,
    errors: result.errors,
    warnings: result.warnings,
  });
}
