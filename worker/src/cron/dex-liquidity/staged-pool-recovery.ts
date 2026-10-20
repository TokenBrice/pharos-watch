import type { Abi } from "abitype";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { buildChainAddressKey } from "./token-resolution";

const STAGED_POOL_RECOVERY_MAX_POOLS = 12;
const STAGED_POOL_RECOVERY_MAX_AGE_SEC = 4 * 60 * 60;

export const ERC20_RECOVERY_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);

export interface StagedPoolRecoveryRow {
  pool_id: string;
  base_token: string | null;
  quote_token: string | null;
}

export interface StagedPoolRecoveryRowWithFeeTier extends StagedPoolRecoveryRow {
  fee_tier: number | null;
}

/**
 * Slipstream ranks non-null staged fee tiers (basis points) ahead of TVL;
 * BSC reads fees onchain and ranks by TVL. Query failures remain caller-owned.
 */
export async function loadStagedPoolRecoveryRows(
  db: D1Database,
  input: { chain: string; dexId: string; withFeeTier: true },
): Promise<StagedPoolRecoveryRowWithFeeTier[]>;
export async function loadStagedPoolRecoveryRows(
  db: D1Database,
  input: { chain: string; dexId: string; withFeeTier?: false },
): Promise<StagedPoolRecoveryRow[]>;
export async function loadStagedPoolRecoveryRows(
  db: D1Database,
  input: { chain: string; dexId: string; withFeeTier?: boolean },
): Promise<StagedPoolRecoveryRow[]> {
  const selectList = input.withFeeTier
    ? "pool_id, base_token, quote_token, fee_tier"
    : "pool_id, base_token, quote_token";
  const innerSelectList = input.withFeeTier
    ? "pool_id, base_token, quote_token, fee_tier, tvl_usd"
    : "pool_id, base_token, quote_token, tvl_usd";
  const rankOrder = input.withFeeTier
    ? "(fee_tier IS NOT NULL) DESC, tvl_usd DESC, stablecoin_id, source"
    : "tvl_usd DESC, stablecoin_id, source";
  const result = await db
    .prepare(
      `SELECT ${selectList}
       FROM (
         SELECT ${innerSelectList},
                ROW_NUMBER() OVER (
                  PARTITION BY pool_id
                  ORDER BY ${rankOrder}
                ) AS candidate_rank
         FROM dex_pool_registry
         WHERE chain = ? AND dex_id = ? AND refreshed_at >= ?
           AND source IN ('cg_onchain', 'gecko_terminal', 'dexscreener')
           AND base_token IS NOT NULL AND quote_token IS NOT NULL
       )
       WHERE candidate_rank = 1
       ORDER BY tvl_usd DESC, pool_id
       LIMIT ?`,
    )
    .bind(
      input.chain,
      input.dexId,
      Math.floor(Date.now() / 1_000) - STAGED_POOL_RECOVERY_MAX_AGE_SEC,
      STAGED_POOL_RECOVERY_MAX_POOLS,
    )
    .all<StagedPoolRecoveryRow>();
  return result.results ?? [];
}

export function decodeStagedMulticallResult<T>(
  result: EvmMulticall3Result | undefined,
  abi: Abi,
  functionName: string,
): T | null {
  if (!result?.success) return null;
  try {
    return decodeFunctionResult({ abi, functionName, data: result.returnData }) as T;
  } catch {
    return null;
  }
}

export function mapStagedMulticallResults(
  results: readonly EvmMulticall3Result[],
): Map<string, EvmMulticall3Result> {
  return new Map(results.map((result) => [result.label, result]));
}

export function erc20RecoveryCalls(
  prefix: string,
  poolAddress: string,
  tokens: Iterable<string>,
): EvmMulticall3Call[] {
  const calls: EvmMulticall3Call[] = [];
  let tokenIndex = 0;
  for (const tokenAddress of tokens) {
    calls.push(
      {
        label: `${prefix}-token-${tokenIndex}-decimals`,
        target: tokenAddress,
        callData: encodeFunctionData({ abi: ERC20_RECOVERY_ABI, functionName: "decimals" }),
      },
      {
        label: `${prefix}-token-${tokenIndex}-balance`,
        target: tokenAddress,
        callData: encodeFunctionData({
          abi: ERC20_RECOVERY_ABI,
          functionName: "balanceOf",
          args: [poolAddress as `0x${string}`],
        }),
      },
    );
    tokenIndex += 1;
  }
  return calls;
}

/** Preserve 12-digit string truncation and Fluid's sign handling; recovery balances/reserves are uint256. */
export function rawAmountToDecimal(value: bigint, decimals: number): number {
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
 * Convert the bounded uint160 ratio to a floating-point significand before
 * squaring, then apply token decimals. Squaring the BigInt first and retaining
 * only 32 raw-ratio fractional bits loses legitimate pools whenever the raw
 * ratio is tiny but the decimal adjustment brings the human price back near
 * one (for example an 18-decimal token paired with 6-decimal USDC).
 */
export function sqrtRatioToSpotPrice(
  sqrtRatio: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  if (sqrtRatio <= 0n) return 0;
  const normalizedSqrtRatio = Number(sqrtRatio) / Math.pow(2, 96);
  return normalizedSqrtRatio * normalizedSqrtRatio * Math.pow(10, token0Decimals - token1Decimals);
}

const CL_POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  // V3 and Slipstream share the first two words, not the trailing fields.
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
]);
const CL_V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]);
const CL_SLIPSTREAM_FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns (address pool)"]);

export interface ClSourcePoolCandidate {
  poolAddress: `0x${string}`;
  expectedTokens?: ReadonlySet<string>;
}

/** Source identity capture is independent of measured-deployment admission. */
export async function captureClSourcePools<T extends ClSourcePoolCandidate>(input: {
  chain: string;
  factoryAddress: string;
  parameterName: "fee" | "tickSpacing";
  maxParameter: number;
  valuation: "tracked-positive" | "pool-implied";
  candidates: readonly T[];
  chainAddressToId: Map<string, string>;
  trackedStablecoinPrices: Map<string, number>;
  options: EvmRpcOptions;
}) {
  const blockNumber = await fetchEvmBlockNumber(input.chain, input.options);
  if (blockNumber == null) throw new Error("cl-capture-block-unavailable");
  const header = await fetchEvmBlockHeader(input.chain, blockNumber, input.options);
  if (!header || header.number !== blockNumber) throw new Error("cl-capture-header-unavailable");
  const options = { ...input.options, stateBlockHash: header.hash };
  const stateCalls = input.candidates.flatMap((candidate, index) => [
    ...(["factory", "token0", "token1", input.parameterName, "slot0"] as const).map((functionName) => ({
      label: `cl-${index}-${functionName}`, target: candidate.poolAddress,
      callData: encodeFunctionData({ abi: CL_POOL_ABI, functionName }),
    })),
    ...(candidate.expectedTokens ? erc20RecoveryCalls(`cl-${index}`, candidate.poolAddress, candidate.expectedTokens) : []),
  ]);
  const rawState = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, stateCalls, blockNumber, options);
  if (!rawState) throw new Error("cl-capture-state-unavailable");
  const state = mapStagedMulticallResults(rawState);
  const decoded = input.candidates.flatMap((candidate, index) => {
    const prefix = `cl-${index}`;
    const factory = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-factory`), CL_POOL_ABI, "factory"));
    const token0 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token0`), CL_POOL_ABI, "token0"));
    const token1 = canonicalEvmAddress(decodeStagedMulticallResult<string>(state.get(`${prefix}-token1`), CL_POOL_ABI, "token1"));
    const parameter = decodeStagedMulticallResult<number>(state.get(`${prefix}-${input.parameterName}`), CL_POOL_ABI, input.parameterName);
    const slot0 = decodeStagedMulticallResult<readonly [bigint, number]>(state.get(`${prefix}-slot0`), CL_POOL_ABI, "slot0");
    if (factory !== input.factoryAddress.toLowerCase() || !token0 || !token1 || token0 === token1 ||
      (candidate.expectedTokens != null && (candidate.expectedTokens.size !== 2 || !candidate.expectedTokens.has(token0) || !candidate.expectedTokens.has(token1))) ||
      parameter == null || !Number.isInteger(parameter) || parameter <= 0 || parameter > input.maxParameter ||
      !slot0 || slot0[0] <= 0n) return [];
    return [{ candidate, prefix, token0, token1, parameter, sqrtPriceX96: slot0[0] }];
  });
  const factoryAbi = input.parameterName === "tickSpacing" ? CL_SLIPSTREAM_FACTORY_ABI : CL_V3_FACTORY_ABI;
  const bindingCalls = decoded.flatMap((row) => [
    { label: `${row.prefix}-membership`, target: input.factoryAddress,
      callData: encodeFunctionData({ abi: factoryAbi, functionName: "getPool", args: [row.token0, row.token1, row.parameter] }) },
    ...(row.candidate.expectedTokens ? [] : erc20RecoveryCalls(row.prefix, row.candidate.poolAddress, [row.token0, row.token1])),
  ]);
  const rawBindings = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, bindingCalls, blockNumber, options);
  if (!rawBindings) throw new Error("cl-capture-binding-unavailable");
  const closing = await fetchEvmBlockHeader(input.chain, blockNumber, input.options);
  if (!closing || closing.number !== header.number || closing.hash !== header.hash) throw new Error("cl-capture-header-changed");
  const bindings = mapStagedMulticallResults(rawBindings);
  const pools = [];
  for (const row of decoded) {
    const membership = canonicalEvmAddress(decodeStagedMulticallResult<string>(bindings.get(`${row.prefix}-membership`), factoryAbi, "getPool"));
    if (membership !== row.candidate.poolAddress) continue;
    const stagedTokens = row.candidate.expectedTokens ? [...row.candidate.expectedTokens] : null;
    const tokenRows = [row.token0, row.token1].flatMap((address, index) => {
      const tokenIndex = stagedTokens ? stagedTokens.indexOf(address) : index;
      const tokenState = stagedTokens ? state : bindings;
      const decimals = decodeStagedMulticallResult<number>(tokenState.get(`${row.prefix}-token-${tokenIndex}-decimals`), ERC20_RECOVERY_ABI, "decimals");
      const balance = decodeStagedMulticallResult<bigint>(tokenState.get(`${row.prefix}-token-${tokenIndex}-balance`), ERC20_RECOVERY_ABI, "balanceOf");
      if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 || balance == null) return [];
      const id = input.chainAddressToId.get(buildChainAddressKey(input.chain, address));
      const reference = id ? input.trackedStablecoinPrices.get(id) : undefined;
      if (input.valuation === "tracked-positive" && (!id || reference == null || reference <= 0 || balance <= 0n)) return [];
      return [{ address, decimals, symbol: id ?? `TOKEN${index}`, balance: rawAmountToDecimal(balance, decimals), reference }];
    });
    if (tokenRows.length !== 2) continue;
    const price = sqrtRatioToSpotPrice(row.sqrtPriceX96, tokenRows[0]!.decimals, tokenRows[1]!.decimals);
    const price0 = tokenRows[0]!.reference ?? (tokenRows[1]!.reference != null ? price * tokenRows[1]!.reference : null);
    const price1 = tokenRows[1]!.reference ?? (tokenRows[0]!.reference != null ? tokenRows[0]!.reference / price : null);
    if (!Number.isFinite(price) || price <= 0 || price0 == null || price1 == null || !Number.isFinite(price0) || !Number.isFinite(price1) || price0 <= 0 || price1 <= 0) continue;
    const tvlUsd = tokenRows[0]!.balance * price0 + tokenRows[1]!.balance * price1;
    if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) continue;
    pools.push({
      candidate: row.candidate, parameter: row.parameter, price, tvlUsd,
      tokens: tokenRows.map((token, index) => ({ address: token.address, symbol: token.symbol, decimals: token.decimals, priceUsd: index === 0 ? price0 : price1 })),
      balances: tokenRows.map((token) => token.balance),
    });
  }
  return { pools, blockNumber };
}
