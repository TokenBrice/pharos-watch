import { makeNoopD1 } from "../../test-helpers/noop-d1";
import type { MockFetchOutcome, MockRoute } from "@shared/test-utils/mock-fetch";
import { jsonResponse } from "@shared/test-utils/mock-fetch";

export function makeFluidRpcResponse(words: Array<number | bigint>): Response {
  const result = `0x${words.map((word) => BigInt(word).toString(16).padStart(64, "0")).join("")}`;
  return jsonResponse({ jsonrpc: "2.0", id: 1, result });
}

export function orcaRoute(cursor: string | null, outcomes: MockFetchOutcome[]): MockRoute {
  const url = new URL("https://api.orca.so/v2/solana/pools");
  url.search = new URLSearchParams({
    sortBy: "tvl", sortDirection: "desc", minTvl: "10000", size: "200",
    ...(cursor ? { next: cursor } : {}),
  }).toString();
  return { match: url.toString(), outcomes };
}

interface FluidTicker {
  ticker_id: string; base_currency: string; target_currency: string; last_price: string;
  base_volume: string; target_volume: string; pool_id: string; liquidity_in_usd: string;
}

export function makeFluidTicker(overrides: Partial<FluidTicker> = {}): FluidTicker {
  return {
    ticker_id: "0xbase_0xquote",
    base_currency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    target_currency: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    last_price: "0.9999", base_volume: "100000", target_volume: "100000",
    pool_id: "0x1111111111111111111111111111111111111111", liquidity_in_usd: "500000",
    ...overrides,
  };
}

export function makeOrcaPool(address: string, overrides: Partial<{
  price: string; tvlUsdc: string; feeRate: number;
  tokenA: { address: string; symbol: string; decimals: number };
  tokenB: { address: string; symbol: string; decimals: number };
  tokenBalanceA: string; tokenBalanceB: string; stats: { "24h": { volume: string } };
}> = {}) {
  return {
    address, price: "1", tvlUsdc: "100000", feeRate: 100,
    tokenA: { address: "mintA", symbol: "USDC", decimals: 6 },
    tokenB: { address: "mintB", symbol: "USDT", decimals: 6 },
    tokenBalanceA: "50000", tokenBalanceB: "50000", stats: { "24h": { volume: "1000" } },
    ...overrides,
  };
}

export function makeBalancerPool(overrides: {
  id: string; address?: string; type?: string; chain?: string;
  dynamicData?: { totalLiquidity: string; volume24h: string; swapFee: string };
  poolTokens: Array<{ address: string; symbol: string; decimals: number; balance: string; balanceUSD: string }>;
}) {
  return {
    type: "STABLE", chain: "MAINNET",
    dynamicData: { totalLiquidity: "100000", volume24h: "1000", swapFee: "0.0001" },
    ...overrides,
  };
}

export function makeCursorDb(cursor: string, failWriteAttempt?: number) {
  const state = { cursor, writeAttempts: 0, persistedCursors: [] as string[] };
  const db = makeNoopD1({
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (!sql.includes("SELECT cursor")) throw new Error(`Unexpected cursor query: ${sql}`);
          return { cursor: state.cursor, cycle_started_at: 100, updated_at: 110, completed_at: null, pages_fetched: 4 };
        },
        run: async () => {
          state.writeAttempts++;
          if (state.writeAttempts === failWriteAttempt) throw new Error("cursor write unavailable");
          state.cursor = String(binds[1]);
          state.persistedCursors.push(state.cursor);
          return { success: true, meta: { changes: 1 } };
        },
      }),
    }),
  });
  return { db, state };
}
