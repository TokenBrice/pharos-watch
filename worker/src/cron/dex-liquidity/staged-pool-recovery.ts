import type { Abi } from "abitype";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import type { EvmMulticall3Call, EvmMulticall3Result } from "../../lib/evm-rpc";

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
    ? "(fee_tier IS NOT NULL) DESC, tvl_usd DESC, stablecoin_id"
    : "tvl_usd DESC, stablecoin_id";
  const result = await db
    .prepare(
      `SELECT ${selectList}
       FROM (
         SELECT ${innerSelectList},
                ROW_NUMBER() OVER (
                  PARTITION BY pool_id
                  ORDER BY ${rankOrder}
                ) AS candidate_rank
         FROM dex_pool_staging
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
