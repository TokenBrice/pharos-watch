import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";
import { makeDexApiFetchResult, type DexApiFetchResult, type DexApiPool } from "../../lib/dex-api-common";
import { throwIfAborted } from "../../lib/abort";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { resolveTrackedStablecoinId } from "./token-resolution";
import { classifyClPoolType, normalizeFeeRateFromBps } from "./direct-source-helpers";
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import { toErrorMessage } from "../../lib/error-utils";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PAGE_SIZE = 500;
const MAX_PAGES = 8;
const SUGAR_ABI = parseAbi([
  "function all(uint256 _limit, uint256 _offset) view returns ((address lp,string symbol,uint8 decimals,uint256 liquidity,int24 type,int24 tick,uint160 sqrt_ratio,address token0,uint256 reserve0,uint256 staked0,address token1,uint256 reserve1,uint256 staked1,address gauge,uint256 gauge_liquidity,bool gauge_alive,address fee,address bribe,address factory,uint256 emissions,address emissions_token,uint256 pool_fee,uint256 unstaked_fee,uint256 token0_fees,uint256 token1_fees,address nfpm,address alm,address root)[])",
  "function tokens(uint256 _limit, uint256 _offset, address _account, address[] _addresses) view returns ((address token_address,string symbol,uint8 decimals,uint256 account_balance,bool listed)[])",
]);

type SlipstreamProtocol = "aerodrome-slipstream" | "velodrome-slipstream";

type SugarPool = {
  lp: string;
  type: number;
  token0: string;
  reserve0: bigint;
  token1: string;
  reserve1: bigint;
  sqrt_ratio: bigint;
  pool_fee: bigint;
};

type SugarToken = {
  token_address: string;
  symbol: string;
  decimals: number;
};

export function projectSugarPoolPage(decoded: readonly SugarPool[]): SugarPool[] {
  const pools: SugarPool[] = [];
  for (const pool of decoded) {
    if (!(Number(pool.type) > 0)) continue;
    pools.push({
      lp: pool.lp,
      type: pool.type,
      token0: pool.token0,
      reserve0: pool.reserve0,
      token1: pool.token1,
      reserve1: pool.reserve1,
      sqrt_ratio: pool.sqrt_ratio,
      pool_fee: pool.pool_fee,
    });
  }
  return pools;
}

export function projectSugarTokens(decoded: readonly SugarToken[]): Map<string, SugarToken> {
  const tokens = new Map<string, SugarToken>();
  for (const token of decoded) {
    tokens.set(normalizeAddress(token.token_address), {
      token_address: token.token_address,
      symbol: token.symbol,
      decimals: token.decimals,
    });
  }
  return tokens;
}

const SLIPSTREAM_CONFIG: Record<SlipstreamProtocol, { chain: string; sugarAddress: string }> = {
  "aerodrome-slipstream": {
    chain: "base",
    sugarAddress: "0x27fc745390d1f4BaF8D184FBd97748340f786634",
  },
  "velodrome-slipstream": {
    chain: "optimism",
    sugarAddress: "0xA64db2D254f07977609def75c3A7db3eDc72EE1D",
  },
};

function bigintToDecimal(value: bigint, decimals: number): number {
  if (decimals <= 0) return Number(value);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const remainder = value % divisor;
  return Number(`${whole}.${remainder.toString().padStart(decimals, "0").slice(0, 12)}`);
}

/**
 * Sugar's `pool_fee` is a raw basis-point integer. Observed values on
 * Aerodrome/Velodrome live pools: 1, 5, 30, 100 bps (0.01%-1.00%).
 * Anything outside [1, 10000] bps indicates either a pool misconfiguration
 * or a Sugar ABI change; log and drop to the generic-fee fallback bucket.
 */
export function getSlipstreamPoolFeeBps(poolFee: bigint): number | null {
  const asNumber = Number(poolFee);
  if (!Number.isFinite(asNumber) || asNumber < 1 || asNumber > 10_000) {
    return null;
  }
  return asNumber;
}

/**
 * Convert a Uniswap V3-style sqrtPriceX96 (Q64.96) to a decimal-adjusted
 * spot price: the amount of token1 you receive per 1 token0 (in human
 * decimal units). Equivalent to: given 1 unit of token0, how many token1.
 * Consumers: `USD(token0) = spotPrice * USD(token1)`.
 *
 *   sqrtRatio   = sqrt(reserve1_wei / reserve0_wei) * 2^96   (Uniswap V3 convention)
 *   ratio_raw   = (sqrtRatio / 2^96)^2                         (reserve1_wei / reserve0_wei)
 *   spotPrice   = ratio_raw * 10^(token0Decimals - token1Decimals)
 *
 * Uses BigInt for the squared intermediate to avoid precision loss on
 * sqrtRatio values above 2^53. Number(whole) only loses precision if the
 * raw ratio exceeds 2^53 (~9e15) — stablecoin-scale pairs never approach that.
 */
export function sqrtRatioToSpotPrice(
  sqrtRatio: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  if (sqrtRatio <= 0n) return 0;
  const squared = sqrtRatio * sqrtRatio;
  const Q192 = 1n << 192n;
  const whole = squared / Q192;
  const remainder = squared % Q192;
  const frac = (remainder << 32n) / Q192;
  const priceRaw = Number(whole) + Number(frac) / Math.pow(2, 32);
  return priceRaw * Math.pow(10, token0Decimals - token1Decimals);
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

async function fetchSugarPools(
  chain: string,
  sugarAddress: string,
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  signal?: AbortSignal,
): Promise<SugarPool[]> {
  const pools: SugarPool[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    throwIfAborted(signal);
    const data = encodeFunctionData({
      abi: SUGAR_ABI,
      functionName: "all",
      args: [BigInt(PAGE_SIZE), BigInt(page * PAGE_SIZE)],
    });
    const result = await fetchEvmCallHexAtBlock(chain, sugarAddress, data, "latest", {
      signal,
      timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
      chainRpcs,
      gas: "0x5B8D80",
    });
    if (!result) break;

    const decoded = decodeFunctionResult({
      abi: SUGAR_ABI,
      functionName: "all",
      data: result,
    }) as readonly SugarPool[];

    if (decoded.length === 0) break;
    pools.push(...projectSugarPoolPage(decoded));
    if (decoded.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      throw new Error(`pagination cap reached at page ${page + 1}; resumeFromOffset=${MAX_PAGES * PAGE_SIZE}`);
    }
  }

  return pools;
}

async function fetchSugarTokens(
  chain: string,
  sugarAddress: string,
  addresses: string[],
  chainRpcs: Map<string, ChainRpcConfig> | undefined,
  signal?: AbortSignal,
): Promise<Map<string, SugarToken>> {
  if (addresses.length === 0) return new Map();
  const data = encodeFunctionData({
    abi: SUGAR_ABI,
    functionName: "tokens",
    args: [BigInt(addresses.length), 0n, ZERO_ADDRESS, addresses as `0x${string}`[]],
  });
  const result = await fetchEvmCallHexAtBlock(chain, sugarAddress, data, "latest", {
    signal,
    timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS,
    chainRpcs,
    gas: "0x5B8D80",
  });
  if (!result) return new Map();

  const decoded = decodeFunctionResult({
    abi: SUGAR_ABI,
    functionName: "tokens",
    data: result,
  }) as readonly SugarToken[];

  return projectSugarTokens(decoded);
}

export async function fetchSlipstreamPools(
  protocol: SlipstreamProtocol,
  chainAddressToId: Map<string, string>,
  symbolToChainScopedIds: Map<string, Map<string, string[]>>,
  trackedStablecoinPrices: Map<string, number>,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<DexApiFetchResult> {
  const config = SLIPSTREAM_CONFIG[protocol];
  const errors: string[] = [];
  try {
    const clPools = await fetchSugarPools(config.chain, config.sugarAddress, chainRpcs, signal);
    const tokenAddresses = Array.from(new Set(
      clPools.flatMap((pool) => [normalizeAddress(pool.token0), normalizeAddress(pool.token1)]),
    ));
    const tokenMap = await fetchSugarTokens(config.chain, config.sugarAddress, tokenAddresses, chainRpcs, signal);

    const pools: DexApiPool[] = [];
    for (const pool of clPools) {
      const tickSpacing = Number(pool.type);
      if (!Number.isInteger(tickSpacing) || tickSpacing <= 0 || tickSpacing > 8_388_607) continue;
      const token0 = tokenMap.get(normalizeAddress(pool.token0));
      const token1 = tokenMap.get(normalizeAddress(pool.token1));
      if (!token0 || !token1) continue;

      const reserve0 = bigintToDecimal(pool.reserve0, token0.decimals);
      const reserve1 = bigintToDecimal(pool.reserve1, token1.decimals);
      if (!Number.isFinite(reserve0) || !Number.isFinite(reserve1) || reserve0 <= 0 || reserve1 <= 0) continue;

      const stable0 = resolveTrackedStablecoinId(
        { chain: config.chain, address: token0.token_address, symbol: token0.symbol },
        { chainAddressToId, symbolToChainScopedIds },
      );
      const stable1 = resolveTrackedStablecoinId(
        { chain: config.chain, address: token1.token_address, symbol: token1.symbol },
        { chainAddressToId, symbolToChainScopedIds },
      );

      let token0PriceUsd = stable0.status === "matched" && stable0.stablecoinId
        ? trackedStablecoinPrices.get(stable0.stablecoinId) ?? null
        : null;
      let token1PriceUsd = stable1.status === "matched" && stable1.stablecoinId
        ? trackedStablecoinPrices.get(stable1.stablecoinId) ?? null
        : null;

      // v5.5: derive spot price from on-chain sqrt_ratio (Q64.96), not reserve ratio.
      // Concentrated-liquidity pools distribute reserves across ticks; reserve1/reserve0
      // equals spot price only at full-range or perfectly balanced positions.
      const spotPriceToken1InToken0 =
        pool.sqrt_ratio > 0n
          ? sqrtRatioToSpotPrice(pool.sqrt_ratio, token0.decimals, token1.decimals)
          : null;
      const finalSpotPrice =
        spotPriceToken1InToken0 != null &&
        Number.isFinite(spotPriceToken1InToken0) &&
        spotPriceToken1InToken0 > 0
          ? spotPriceToken1InToken0
          : null;

      // Missing-side price derivation uses spot price, not reserve ratio.
      // 1 token0 = spotPrice token1 → USD(token0) = spotPrice * USD(token1)
      if ((token0PriceUsd == null || token0PriceUsd <= 0) && token1PriceUsd != null && token1PriceUsd > 0) {
        token0PriceUsd = finalSpotPrice != null ? finalSpotPrice * token1PriceUsd : null;
      }
      // 1 token1 = 1/spotPrice token0 → USD(token1) = USD(token0) / spotPrice
      if ((token1PriceUsd == null || token1PriceUsd <= 0) && token0PriceUsd != null && token0PriceUsd > 0) {
        token1PriceUsd =
          finalSpotPrice != null && finalSpotPrice > 0 ? token0PriceUsd / finalSpotPrice : null;
      }

      // Drop pool entirely when one side has no tracked price and sqrt_ratio is unusable.
      // No reserve-ratio fallback derivation reaches downstream consumers.
      if (token0PriceUsd == null || token1PriceUsd == null) continue;

      const tvlUsd = reserve0 * token0PriceUsd + reserve1 * token1PriceUsd;
      if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;

      const feeBps = getSlipstreamPoolFeeBps(pool.pool_fee);
      if (feeBps == null) {
        console.warn(
          `[fetch-slipstream] ${protocol} pool ${pool.lp}: unexpected pool_fee ${pool.pool_fee}`,
        );
      }
      const effectiveFeeBps = feeBps ?? 30;
      pools.push({
        source: protocol,
        chain: config.chain,
        poolAddress: pool.lp,
        poolType: classifyClPoolType(protocol, effectiveFeeBps),
        tokens: [
          {
            address: token0.token_address,
            symbol: token0.symbol,
            decimals: token0.decimals,
            priceUsd: token0PriceUsd,
          },
          {
            address: token1.token_address,
            symbol: token1.symbol,
            decimals: token1.decimals,
            priceUsd: token1PriceUsd,
          },
        ],
        price: finalSpotPrice,
        tvlUsd,
        // Sugar v2 exposes reserves and pool price but not trailing volume.
        // Keep this as unmeasured zero so downstream filters can distinguish
        // "unknown volume" from a measured no-volume pool.
        volume24hUsd: 0,
        feeRate: normalizeFeeRateFromBps(effectiveFeeBps),
        tickSpacing,
        balances: [reserve0, reserve1],
      });
    }

    if (pools.length > 0) {
      console.log(`[fetch-slipstream] ${protocol} fetched ${pools.length} pools`);
    }
    return makeDexApiFetchResult(pools, { ok: true, degraded: false, errors });
  } catch (error) {
    const message = toErrorMessage(error);
    errors.push(message);
    console.warn("[fetch-slipstream]", protocol, message);
    return makeDexApiFetchResult([], { ok: false, degraded: true, errors });
  }
}
