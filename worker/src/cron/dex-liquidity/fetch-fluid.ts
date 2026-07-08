import { toErrorMessage } from "../../lib/error-utils";
import {
  DIRECT_API_POOL_MIN_TVL_USD,
  makeDexApiFetchResult,
  type DexApiFetchResult,
  type DexApiPool,
} from "../../lib/dex-api-common";
import { USER_AGENT } from "../../lib/constants";
import { fetchEvmCallHexAtBlock } from "../../lib/evm-rpc";
import { buildChainRpcs, type ChainRpcConfig } from "../../lib/chain-registry";
import { encodeAddress } from "../../lib/evm-selectors";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { DIRECT_API_REQUEST_TIMEOUT_MS } from "./direct-api-policy";
import { rethrowIfAborted } from "../../lib/abort";

const FLUID_API_BASE = "https://api.fluid.instadapp.io/v2";
const FLUID_RESOLVER_CALL_GAS = "0x0F4240";
const FLUID_GET_COLLATERAL_RESERVES_SELECTOR = "0x957755e6";
const FLUID_GET_DEBT_RESERVES_SELECTOR = "0x55181f11";
const FLUID_GET_POOL_FEE_SELECTOR = "0x42fcc6fb";
const FLUID_RETRY_DELAY_CAP_MS = 5_000;

/** Fluid API chain IDs mapped to our internal chain keys */
const FLUID_CHAINS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  bsc: 56,
  plasma: 9745,
};

/** Official Fluid DexReservesResolver deployments from instadapp/fluid-deployments. */
const FLUID_RESOLVER_BY_CHAIN: Partial<Record<keyof typeof FLUID_CHAINS, string>> = {
  ethereum: "0xC93876C0EEd99645DD53937b25433e311881A27C",
  arbitrum: "0x666A400b8cDA0Dc9b59D61706B0F982dDdAF2d98",
  base: "0x41E6055a282F8b7Abdb8D22Bcd85c2A0eE22e38A",
  polygon: "0x18DeDd1cF3Af3537D4e726D2Aa81004D65DA8581",
};

interface FluidTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  pool_id: string;
  liquidity_in_usd: string;
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INVALID_FLUID_POOL_ID_LOG_LIMIT = 80;

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value);
}

function formatInvalidFluidPoolId(value: unknown): string {
  if (typeof value !== "string") return String(value);
  return value.length > INVALID_FLUID_POOL_ID_LOG_LIMIT
    ? `${value.slice(0, INVALID_FLUID_POOL_ID_LOG_LIMIT)}…(${value.length} chars)`
    : value;
}

function bigintToDecimalNumber(value: bigint, decimals: number): number {
  if (decimals <= 0) return Number(value);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const fractionDigits = fraction.toString().padStart(decimals, "0").slice(0, 12);
  const asString = `${negative ? "-" : ""}${whole.toString()}.${fractionDigits}`.replace(/\.$/, "");
  return Number(asString);
}

function encodeFluidAddressCall(selector: string, address: string): string {
  return `${selector}${encodeAddress(address)}`;
}

function decodeUint256Words(resultHex: `0x${string}` | null, expectedWords: number): bigint[] | null {
  if (!resultHex) return null;
  const body = resultHex.slice(2);
  if (body.length < expectedWords * 64) return null;

  const words: bigint[] = [];
  for (let i = 0; i < expectedWords; i++) {
    words.push(BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`));
  }
  return words;
}

async function enrichFluidPool(
  chain: keyof typeof FLUID_CHAINS,
  pool: DexApiPool,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<void> {
  const resolver = FLUID_RESOLVER_BY_CHAIN[chain];
  if (!resolver || pool.tvlUsd < DIRECT_API_POOL_MIN_TVL_USD) return;

  const [collateralReservesResult, debtReservesResult, feeResult] = await Promise.allSettled([
    fetchEvmCallHexAtBlock(
      chain,
      resolver,
      encodeFluidAddressCall(FLUID_GET_COLLATERAL_RESERVES_SELECTOR, pool.poolAddress),
      "latest",
      { signal, gas: FLUID_RESOLVER_CALL_GAS, timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS, chainRpcs },
    ),
    fetchEvmCallHexAtBlock(
      chain,
      resolver,
      encodeFluidAddressCall(FLUID_GET_DEBT_RESERVES_SELECTOR, pool.poolAddress),
      "latest",
      { signal, gas: FLUID_RESOLVER_CALL_GAS, timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS, chainRpcs },
    ),
    fetchEvmCallHexAtBlock(
      chain,
      resolver,
      encodeFluidAddressCall(FLUID_GET_POOL_FEE_SELECTOR, pool.poolAddress),
      "latest",
      { signal, gas: FLUID_RESOLVER_CALL_GAS, timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS, chainRpcs },
    ),
  ]);

  const collateralReserves = collateralReservesResult.status === "fulfilled"
    ? decodeUint256Words(collateralReservesResult.value, 4)
    : null;
  const debtReserves = debtReservesResult.status === "fulfilled"
    ? decodeUint256Words(debtReservesResult.value, 6)
    : null;
  const feeWords = feeResult.status === "fulfilled"
    ? decodeUint256Words(feeResult.value, 1)
    : null;

  const token0Balance = (collateralReserves?.[0] ?? 0n) + (debtReserves?.[2] ?? 0n);
  const token1Balance = (collateralReserves?.[1] ?? 0n) + (debtReserves?.[3] ?? 0n);
  const token0Decimals = pool.tokens[0]?.decimals ?? 0;
  const token1Decimals = pool.tokens[1]?.decimals ?? 0;
  if (token0Balance > 0n || token1Balance > 0n) {
    if (Number.isFinite(token0Decimals) && token0Decimals > 0 && Number.isFinite(token1Decimals) && token1Decimals > 0) {
      pool.balances = [
        bigintToDecimalNumber(token0Balance, token0Decimals),
        bigintToDecimalNumber(token1Balance, token1Decimals),
      ];
      pool.balancesNormalized = true;
    } else {
      pool.balances = [Number(token0Balance), Number(token1Balance)];
      pool.balancesNormalized = false;
    }
  }

  const fee = feeWords?.[0] ?? 0n;
  if (fee > 0n) {
    // Fluid fee encoding uses 1% = 10_000, so divide by 1_000_000 for decimal form.
    pool.feeRate = Number(fee) / 1_000_000;
  }
}

export async function fetchFluidPools(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<DexApiFetchResult> {
  const results: DexApiPool[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let successfulChains = 0;
  const resolvedChainRpcs = chainRpcs ?? buildChainRpcs();

  for (const [chain, chainId] of Object.entries(FLUID_CHAINS) as Array<[keyof typeof FLUID_CHAINS, number]>) {
    const url = `${FLUID_API_BASE}/${chainId}/dexes/stats/tickers`;
    try {
      const result = await fetchJsonWithRetry<unknown>(
        url,
        {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal,
        },
        2,
        { timeoutMs: DIRECT_API_REQUEST_TIMEOUT_MS, maxRetryDelayMs: FLUID_RETRY_DELAY_CAP_MS },
      );
      if (!result) {
        throw new Error(`${chain} request failed after retries`);
      }
      if (!result.response.ok) {
        throw new Error(`${chain} returned ${result.response.status}`);
      }
      const tickers = result.body;
      if (!Array.isArray(tickers)) {
        throw new Error(`${chain} returned non-array body`);
      }

      const pools = (tickers as FluidTicker[]).map((t): DexApiPool | null => {
        const tvlUsd = parseFloat(t.liquidity_in_usd);
        const price = parseFloat(t.last_price);
        const baseVol = parseFloat(t.base_volume);
        const targetVol = parseFloat(t.target_volume);
        if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;
        if (!isEvmAddress(t.pool_id)) {
          const warning = `${chain} pool_id ${formatInvalidFluidPoolId(t.pool_id)} skipped: invalid EVM address`;
          warnings.push(warning);
          console.warn("[fetch-fluid]", warning);
          return null;
        }

        return {
          source: "fluid",
          chain,
          poolAddress: t.pool_id,
          poolType: "fluid-dex",
          tokens: [
            { address: t.base_currency, symbol: "", decimals: 0 },
            { address: t.target_currency, symbol: "", decimals: 0 },
          ],
          price: Number.isFinite(price) && price > 0 ? price : null,
          tvlUsd,
          // base_volume/target_volume are raw token-unit amounts; the downstream
          // derivePoolVolume24hUsd path computes USD volume from tokenVolumes24h. Do not
          // misinterpret them here as USD or double-count the two sides.
          volume24hUsd: 0,
          feeRate: null,
          balances: null,
          tokenVolumes24h: [Number.isFinite(baseVol) ? baseVol : 0, Number.isFinite(targetVol) ? targetVol : 0],
        };
      }).filter((p): p is DexApiPool => p !== null);

      successfulChains++;
      for (const pool of pools) {
        try {
          await enrichFluidPool(chain, pool, resolvedChainRpcs, signal);
        } catch (error) {
          rethrowIfAborted(error, signal);
          const reason = toErrorMessage(error);
          warnings.push(`${chain} pool ${pool.poolAddress} enrichment failed: ${reason}`);
          console.warn("[fetch-fluid] Pool enrichment failed:", reason);
        }
      }
      results.push(...pools);
    } catch (error) {
      rethrowIfAborted(error, signal);
      const reason = toErrorMessage(error);
      errors.push(reason);
      console.warn("[fetch-fluid] Chain fetch failed:", reason);
    }
  }

  return makeDexApiFetchResult(results, {
    ok: successfulChains > 0,
    degraded: errors.length > 0,
    errors,
    warnings,
  });
}
