import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decodeUint256WordBigInt,
  encodeAddress,
  encodeUint256,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

export const AERODROME_ONCHAIN_SOURCE = "aerodrome-onchain";
export const VELODROME_ONCHAIN_SOURCE = "velodrome-onchain";

const USX_ID = "usx-dforce";
const USDC_ID = "usdc-circle";
const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const GET_RESERVES_SELECTOR = "0x0902f1ac";
const GET_AMOUNT_OUT_SELECTOR = "0xf140a35a";
const QUOTE_NOTIONAL_TOKENS = 1_000;
const MIN_QUOTE_RESERVE_USD = 25_000;
const MAX_ROUTE_DIVERGENCE_RATIO = 0.05;

interface StablePoolRoute {
  chain: "optimism" | "base";
  pool: `0x${string}`;
  token: `0x${string}`;
  tokenDecimals: number;
  quoteToken: `0x${string}`;
  quoteDecimals: number;
  source: typeof AERODROME_ONCHAIN_SOURCE | typeof VELODROME_ONCHAIN_SOURCE;
}

const USX_STABLE_POOL_ROUTES: readonly StablePoolRoute[] = [
  {
    chain: "optimism",
    pool: "0x2f748ee75538ccee11ec5f523084e810023d8c21",
    token: "0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9",
    tokenDecimals: 18,
    quoteToken: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
    quoteDecimals: 6,
    source: VELODROME_ONCHAIN_SOURCE,
  },
  {
    chain: "base",
    pool: "0x1f019b4420936a800ff6f54c00d9da05445de433",
    token: "0xc142171b138db17a1b7cb999c44526094a4dae05",
    tokenDecimals: 18,
    quoteToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    quoteDecimals: 6,
    source: AERODROME_ONCHAIN_SOURCE,
  },
] as const;

function decodeAddressWord(value: `0x${string}` | null): string | null {
  if (!value || value.length < 66) return null;
  return `0x${value.slice(26, 66)}`.toLowerCase();
}

function decimalFromRaw(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

function routesAgree(prices: readonly number[]): boolean {
  if (prices.length < 2) return false;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min > 0 && (max - min) / min <= MAX_ROUTE_DIVERGENCE_RATIO;
}

async function fetchStablePoolQuote(route: StablePoolRoute, signal?: AbortSignal): Promise<number | null> {
  const options = {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(route.chain),
  };
  const inputRaw = BigInt(QUOTE_NOTIONAL_TOKENS) * 10n ** BigInt(route.tokenDecimals);
  const quoteCall = `${GET_AMOUNT_OUT_SELECTOR}${encodeUint256(inputRaw)}${encodeAddress(route.token)}`;
  const [token0Raw, token1Raw, reservesRaw, outputRaw] = await Promise.all([
    fetchEvmCallHexAtBlock(route.chain, route.pool, TOKEN0_SELECTOR, "latest", options),
    fetchEvmCallHexAtBlock(route.chain, route.pool, TOKEN1_SELECTOR, "latest", options),
    fetchEvmCallHexAtBlock(route.chain, route.pool, GET_RESERVES_SELECTOR, "latest", options),
    fetchEvmCallHexAtBlock(route.chain, route.pool, quoteCall, "latest", options),
  ]);

  const token0 = decodeAddressWord(token0Raw);
  const token1 = decodeAddressWord(token1Raw);
  const expectedTokens = new Set([route.token.toLowerCase(), route.quoteToken.toLowerCase()]);
  if (!token0 || !token1 || !expectedTokens.has(token0) || !expectedTokens.has(token1) || token0 === token1) {
    return null;
  }

  const reserve0 = reservesRaw ? decodeUint256WordBigInt(reservesRaw, 0) : null;
  const reserve1 = reservesRaw ? decodeUint256WordBigInt(reservesRaw, 1) : null;
  const output = outputRaw ? decodeUint256WordBigInt(outputRaw, 0) : null;
  if (reserve0 == null || reserve1 == null || output == null || output <= 0n) return null;

  const quoteReserveRaw = token0 === route.quoteToken.toLowerCase() ? reserve0 : reserve1;
  const quoteReserve = decimalFromRaw(quoteReserveRaw, route.quoteDecimals);
  if (!Number.isFinite(quoteReserve) || quoteReserve < MIN_QUOTE_RESERVE_USD) return null;

  const quoteAmount = decimalFromRaw(output, route.quoteDecimals);
  const price = quoteAmount / QUOTE_NOTIONAL_TOKENS;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function fetchUsxStablePoolPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
): Promise<CurrentPriceOverride | null> {
  const quoteParent = resolveTrustedOverrideParent(
    context,
    USDC_ID,
    () => `[authoritative-price-sources] ${USX_ID}: trusted USDC quote dependency unavailable`,
    {
      allowFreshNonReplaySafeParent: true,
      allowFreshReplaySafeSingleSourceParent: true,
    },
  );
  if (!quoteParent) return null;

  const routePrices: number[] = [];
  for (const route of USX_STABLE_POOL_ROUTES) {
    const price = await fetchStablePoolQuote(route, signal);
    if (price == null) return null;
    routePrices.push(price * quoteParent.trustedParent.price);
  }
  if (!routesAgree(routePrices)) return null;

  const price = routePrices.reduce((sum, value) => sum + value, 0) / routePrices.length;
  return {
    price,
    source: `${AERODROME_ONCHAIN_SOURCE}+${VELODROME_ONCHAIN_SOURCE}`,
    confidence: "high",
    observedAt: Math.floor(Date.now() / 1000),
    observedAtMode: "local_fetch",
  };
}

export const usxStablePoolProvider: PriceSourceProvider = {
  source: `${AERODROME_ONCHAIN_SOURCE}+${VELODROME_ONCHAIN_SOURCE}`,
  livePriority: 1,
  matches(stablecoinId: string): boolean {
    return stablecoinId === USX_ID;
  },
  async fetchLivePrice(
    _asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    return fetchUsxStablePoolPrice(context, signal);
  },
};
