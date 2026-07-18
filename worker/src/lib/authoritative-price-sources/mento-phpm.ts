import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import { CIRCUIT_SOURCE } from "../constants";
import { fetchEvmBlockNumber, fetchEvmBlockTimestamp, fetchEvmCallHexAtBlock } from "../evm-rpc";
import { getPublicFallbackRpcUrls } from "../public-rpc-registry";
import {
  decodeUint256WordBigInt,
  encodeAddress,
  encodeUint256,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type CurrentPriceOverride,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const PHPM_ID = "phpm-mento";
const USDM_ID = "cusd-celo";
const USDT_ID = "usdt-tether";
const USDC_ID = "usdc-circle";
const CELO_CHAIN = "celo";
const MENTO_BROKER = "0x777a8255ca72412f0d706dc03c9d1987306b4cad";
const MENTO_BIPOOL_MANAGER = "0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901";
const PHPM_TOKEN = "0x105d4a9306d2e55a71d2eb95b81553ae1dc20d7b";
const USDM_TOKEN = "0x765de816845861e75a25fca122bb6898b8b1282a";
const PHPM_USDM_EXCHANGE_ID = "7952984d7278ca3417febf52815c321984ac3147ced2c02bb6a02b0bcab08413";
const UNISWAP_V3_FACTORY = "0xafe208a311b21f13ef87e33a90049fc17a7acdec";
const UNISWAP_V3_QUOTER_V2 = "0x82825d0554fa07f7fc52ab63c961f330fdefa8e8";
const PHPM_USDT_POOL = "0x87dec9a2589d9e6511df84c193561b3a16cf6238";
const PHPM_USDC_POOL = "0xb466d5429d6ad9999bf112c225d9d7b15e96c658";
const USDT_TOKEN = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
const USDC_TOKEN = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";
const UNISWAP_V3_SOURCE = "uniswap-v3-exact";
const UNISWAP_V3_FEE_PIPS = 100;
const UNISWAP_QUOTE_DECIMALS = 6;
const UNISWAP_SMALL_QUOTE_TOKENS = 1_000;
const UNISWAP_LARGE_QUOTE_TOKENS = 10_000;
const MAX_UNISWAP_ROUTE_IMPACT_BPS = 100;
const MAX_UNISWAP_ROUTE_DIVERGENCE_BPS = 100;
const GET_POOL_EXCHANGE_SELECTOR = "0x278488a4";
const BROKER_GET_AMOUNT_OUT_SELECTOR = "0xa20f2305";
const QUOTE_NOTIONAL_TOKENS = 1_000;
const TOKEN_DECIMALS = 18;
const MIN_COUNTER_CAPACITY = 1_000_000;
const MAX_BLOCK_AGE_SEC = 5 * 60;
const MAX_BLOCK_FUTURE_SKEW_SEC = 60;

const UNISWAP_V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
const UNISWAP_V3_QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

function decodeAddressWord(value: `0x${string}`, wordIndex: number): string | null {
  const start = 2 + wordIndex * 64;
  const end = start + 64;
  if (value.length < end) return null;
  return `0x${value.slice(end - 40, end)}`.toLowerCase();
}

function decimalFromRaw(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}

function buildBrokerQuoteCall(inputRaw: bigint): string {
  return [
    BROKER_GET_AMOUNT_OUT_SELECTOR,
    encodeAddress(MENTO_BIPOOL_MANAGER),
    PHPM_USDM_EXCHANGE_ID,
    encodeAddress(PHPM_TOKEN),
    encodeAddress(USDM_TOKEN),
    encodeUint256(inputRaw),
  ].join("");
}

interface UniswapPhpmRoute {
  parentId: string;
  quoteToken: `0x${string}`;
  pool: `0x${string}`;
}

const UNISWAP_PHPM_ROUTES: readonly UniswapPhpmRoute[] = [
  { parentId: USDT_ID, quoteToken: USDT_TOKEN, pool: PHPM_USDT_POOL },
  { parentId: USDC_ID, quoteToken: USDC_TOKEN, pool: PHPM_USDC_POOL },
];

function buildUniswapPoolBindingCall(route: UniswapPhpmRoute): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V3_FACTORY_ABI,
    functionName: "getPool",
    args: [PHPM_TOKEN, route.quoteToken, UNISWAP_V3_FEE_PIPS],
  });
}

function decodeUniswapPoolBinding(value: `0x${string}`): string | null {
  try {
    return decodeFunctionResult({
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: "getPool",
      data: value,
    }).toLowerCase();
  } catch {
    return null;
  }
}

function buildUniswapQuoteCall(route: UniswapPhpmRoute, inputTokens: number): `0x${string}` {
  return encodeFunctionData({
    abi: UNISWAP_V3_QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: PHPM_TOKEN,
        tokenOut: route.quoteToken,
        amountIn: BigInt(inputTokens) * 10n ** BigInt(TOKEN_DECIMALS),
        fee: UNISWAP_V3_FEE_PIPS,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

function decodeUniswapQuoteAmount(value: `0x${string}`): bigint | null {
  try {
    const [amountOut] = decodeFunctionResult({
      abi: UNISWAP_V3_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      data: value,
    });
    return amountOut > 0n ? amountOut : null;
  } catch {
    return null;
  }
}

function relativeDifferenceBps(left: number, right: number): number {
  const midpoint = (left + right) / 2;
  return midpoint > 0 ? (Math.abs(left - right) / midpoint) * 10_000 : Number.POSITIVE_INFINITY;
}

async function fetchMentoBrokerPrice(
  usdMPrice: number,
  blockNumber: number,
  blockTimestamp: number,
  options: { signal?: AbortSignal; extraRpcUrls: string[] },
): Promise<CurrentPriceOverride | null> {
  const inputRaw = BigInt(QUOTE_NOTIONAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const [poolRaw, quoteRaw] = await Promise.all([
    fetchEvmCallHexAtBlock(
      CELO_CHAIN,
      MENTO_BIPOOL_MANAGER,
      `${GET_POOL_EXCHANGE_SELECTOR}${PHPM_USDM_EXCHANGE_ID}`,
      blockNumber,
      options,
    ),
    fetchEvmCallHexAtBlock(CELO_CHAIN, MENTO_BROKER, buildBrokerQuoteCall(inputRaw), blockNumber, options),
  ]);
  if (!poolRaw || !quoteRaw) return null;

  const asset0 = decodeAddressWord(poolRaw, 0);
  const asset1 = decodeAddressWord(poolRaw, 1);
  const expectedAssets = new Set([PHPM_TOKEN, USDM_TOKEN]);
  if (!asset0 || !asset1 || !expectedAssets.has(asset0) || !expectedAssets.has(asset1) || asset0 === asset1) {
    return null;
  }

  const bucket0 = decodeUint256WordBigInt(poolRaw, 3);
  const bucket1 = decodeUint256WordBigInt(poolRaw, 4);
  const outputRaw = decodeUint256WordBigInt(quoteRaw, 0);
  if (bucket0 == null || bucket1 == null || outputRaw == null || outputRaw <= 0n) return null;

  const counterBucketRaw = asset0 === USDM_TOKEN ? bucket0 : bucket1;
  const counterCapacity = decimalFromRaw(counterBucketRaw, TOKEN_DECIMALS);
  if (!Number.isFinite(counterCapacity) || counterCapacity < MIN_COUNTER_CAPACITY) return null;

  const outputAmount = decimalFromRaw(outputRaw, TOKEN_DECIMALS);
  const price = (outputAmount / QUOTE_NOTIONAL_TOKENS) * usdMPrice;
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    source: PROTOCOL_REDEEM_SOURCE,
    confidence: "high",
    observedAt: blockTimestamp,
    observedAtMode: "upstream",
  };
}

async function fetchUniswapPhpmPrice(
  context: LivePriceContext,
  blockNumber: number,
  blockTimestamp: number,
  options: { signal?: AbortSignal; extraRpcUrls: string[] },
): Promise<CurrentPriceOverride | null> {
  const parents = UNISWAP_PHPM_ROUTES.map((route) =>
    resolveTrustedOverrideParent(
      context,
      route.parentId,
      () => `[authoritative-price-sources] ${PHPM_ID}: trusted ${route.parentId} quote dependency unavailable`,
      {
        allowFreshNonReplaySafeParent: true,
        allowFreshReplaySafeSingleSourceParent: true,
      },
    ),
  );
  if (parents.some((parent) => parent == null)) return null;

  const bindingResults = await Promise.all(
    UNISWAP_PHPM_ROUTES.map((route) =>
      fetchEvmCallHexAtBlock(CELO_CHAIN, UNISWAP_V3_FACTORY, buildUniswapPoolBindingCall(route), blockNumber, options),
    ),
  );
  const bindingsValid = bindingResults.every(
    (result, index) => result != null && decodeUniswapPoolBinding(result) === UNISWAP_PHPM_ROUTES[index]!.pool,
  );
  if (!bindingsValid) return null;

  const quoteCalls = UNISWAP_PHPM_ROUTES.flatMap((route) => [
    { route, inputTokens: UNISWAP_SMALL_QUOTE_TOKENS },
    { route, inputTokens: UNISWAP_LARGE_QUOTE_TOKENS },
  ]);
  const quoteResults = await Promise.all(
    quoteCalls.map(({ route, inputTokens }) =>
      fetchEvmCallHexAtBlock(
        CELO_CHAIN,
        UNISWAP_V3_QUOTER_V2,
        buildUniswapQuoteCall(route, inputTokens),
        blockNumber,
        options,
      ),
    ),
  );

  const routePrices: number[] = [];
  for (let routeIndex = 0; routeIndex < UNISWAP_PHPM_ROUTES.length; routeIndex += 1) {
    const smallOutputRaw = quoteResults[routeIndex * 2];
    const largeOutputRaw = quoteResults[routeIndex * 2 + 1];
    if (!smallOutputRaw || !largeOutputRaw) return null;
    const smallOutput = decodeUniswapQuoteAmount(smallOutputRaw);
    const largeOutput = decodeUniswapQuoteAmount(largeOutputRaw);
    if (smallOutput == null || largeOutput == null) return null;

    const parentPrice = parents[routeIndex]!.trustedParent.price;
    const smallPrice = (decimalFromRaw(smallOutput, UNISWAP_QUOTE_DECIMALS) / UNISWAP_SMALL_QUOTE_TOKENS) * parentPrice;
    const largePrice = (decimalFromRaw(largeOutput, UNISWAP_QUOTE_DECIMALS) / UNISWAP_LARGE_QUOTE_TOKENS) * parentPrice;
    if (
      !Number.isFinite(smallPrice) ||
      smallPrice <= 0 ||
      !Number.isFinite(largePrice) ||
      largePrice <= 0 ||
      relativeDifferenceBps(smallPrice, largePrice) > MAX_UNISWAP_ROUTE_IMPACT_BPS
    )
      return null;
    routePrices.push(smallPrice);
  }

  if (
    routePrices.length !== UNISWAP_PHPM_ROUTES.length ||
    relativeDifferenceBps(routePrices[0]!, routePrices[1]!) > MAX_UNISWAP_ROUTE_DIVERGENCE_BPS
  )
    return null;

  return {
    price: (routePrices[0]! + routePrices[1]!) / 2,
    source: UNISWAP_V3_SOURCE,
    confidence: "fallback",
    observedAt: blockTimestamp,
    observedAtMode: "upstream",
  };
}

export async function fetchMentoPhpmPrice(
  context: LivePriceContext,
  signal?: AbortSignal,
  options: { allowDexFallback?: boolean } = {},
): Promise<CurrentPriceOverride | null> {
  const usdMParent = resolveTrustedOverrideParent(
    context,
    USDM_ID,
    () => `[authoritative-price-sources] ${PHPM_ID}: trusted USDm quote dependency unavailable`,
    {
      allowFreshNonReplaySafeParent: true,
      allowFreshReplaySafeSingleSourceParent: true,
    },
  );
  if (!usdMParent && options.allowDexFallback === false) return null;

  const rpcOptions = {
    signal,
    extraRpcUrls: getPublicFallbackRpcUrls(CELO_CHAIN),
  };
  const blockNumber = await fetchEvmBlockNumber(CELO_CHAIN, rpcOptions);
  if (blockNumber == null) return null;
  const blockTimestamp = await fetchEvmBlockTimestamp(CELO_CHAIN, blockNumber, rpcOptions);
  const nowSec = Math.floor(Date.now() / 1_000);
  if (
    blockTimestamp == null ||
    blockTimestamp > nowSec + MAX_BLOCK_FUTURE_SKEW_SEC ||
    nowSec - blockTimestamp > MAX_BLOCK_AGE_SEC
  )
    return null;

  if (usdMParent) {
    const brokerPrice = await fetchMentoBrokerPrice(
      usdMParent.trustedParent.price,
      blockNumber,
      blockTimestamp,
      rpcOptions,
    );
    if (brokerPrice) return brokerPrice;
  }

  return options.allowDexFallback === false
    ? null
    : fetchUniswapPhpmPrice(context, blockNumber, blockTimestamp, rpcOptions);
}

export const mentoPhpmProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  livePriority: 1,
  liveCircuitSource: CIRCUIT_SOURCE.PHPM_PRICE_ROUTE,
  recordNullLiveResultAsCircuitFailure: true,
  recordLiveCircuitFailuresOnlyWhenMissing: true,
  matches(stablecoinId: string): boolean {
    return stablecoinId === PHPM_ID;
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
    signal?: AbortSignal,
  ): Promise<CurrentPriceOverride | null> {
    const hasUsableInputPrice = typeof asset.price === "number" && Number.isFinite(asset.price) && asset.price > 0;
    return fetchMentoPhpmPrice(context, signal, { allowDexFallback: !hasUsableInputPrice });
  },
};
