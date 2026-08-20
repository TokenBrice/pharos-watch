import { CHAIN_META } from "@shared/lib/chains";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import { finiteDecimalNumberFromBigInt } from "../../lib/bigint";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEvmUint256AtBlock,
} from "../../lib/evm-rpc";
import { encodeAddress, encodeUint256 } from "../../lib/evm-selectors";
import { createOptionalSourceBudget, resolveRpcUrls } from "./sources-helpers";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import type { ResolvedYield } from "./types";
import { toErrorMessage } from "../../lib/error-utils";
import { logWorkerEvent } from "../../lib/structured-log";

const OPTIONAL_PROTOCOL_RPC_BUDGET_MS = 30_000;
const OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS = 10_000;
const OPTIONAL_PROTOCOL_RPC_MAX_RETRIES = 2;
const ON_CHAIN_RATE_REQUEST_TIMEOUT_MS = 6_000;
export const OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT = 20;

export interface OptionalRpcFamilyTelemetry {
  targetCount: number;
  attemptedCount: number;
  resolvedTargetCount: number;
  emittedCount: number;
  missingTargetCount: number;
  missingByChain: Record<string, number>;
  missingReasonCounts: Record<string, number>;
  missingTargets: string[];
  missingTargetsTruncated: boolean;
  budgetExhausted: boolean;
  endpointStrategy: "alternating-fallback-primary";
}

function createOptionalRpcFamilyTelemetry(targetCount: number): OptionalRpcFamilyTelemetry {
  return {
    targetCount,
    attemptedCount: 0,
    resolvedTargetCount: 0,
    emittedCount: 0,
    missingTargetCount: 0,
    missingByChain: {},
    missingReasonCounts: {},
    missingTargets: [],
    missingTargetsTruncated: false,
    budgetExhausted: false,
    endpointStrategy: "alternating-fallback-primary",
  };
}

function buildOptionalRpcTargetLabel(chain: string, symbol: string): string {
  return `${chain}:${symbol}`;
}

function recordOptionalRpcMiss(
  telemetry: OptionalRpcFamilyTelemetry,
  chain: string,
  targetLabel: string,
  reason: string,
): void {
  telemetry.missingTargetCount += 1;
  telemetry.missingByChain[chain] = (telemetry.missingByChain[chain] ?? 0) + 1;
  telemetry.missingReasonCounts[reason] = (telemetry.missingReasonCounts[reason] ?? 0) + 1;
  if (telemetry.missingTargets.length < OPTIONAL_RPC_MISSING_TARGET_EXAMPLE_LIMIT) {
    telemetry.missingTargets.push(targetLabel);
  } else {
    telemetry.missingTargetsTruncated = true;
  }
}

function buildOptionalRpcUrls(rpc: ChainRpcConfig | undefined, rotationSeed = 0): string[] {
  return resolveRpcUrls(rpc, { order: "rotate", seed: rotationSeed });
}

function logOptionalRpcTelemetry(family: string, telemetry: OptionalRpcFamilyTelemetry): void {
  const reasonSummary = Object.entries(telemetry.missingReasonCounts)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");

  if (telemetry.missingTargetCount > 0 || telemetry.budgetExhausted) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "optional-rpc-family-partial",
      message: "Optional RPC family resolved fewer than all targets",
      source: family,
      metadata: {
        resolvedTargetCount: telemetry.resolvedTargetCount,
        targetCount: telemetry.targetCount,
        emittedCount: telemetry.emittedCount,
        attemptedCount: telemetry.attemptedCount,
        missingReasonSummary: reasonSummary || "no-miss-reasons",
        missingReasonCounts: telemetry.missingReasonCounts,
        budgetExhausted: telemetry.budgetExhausted,
      },
    });
    return;
  }

  logWorkerEvent({
    scope: "lib",
    job: "sync-yield-data",
    level: "info",
    event: "optional-rpc-family-complete",
    message: "Optional RPC family resolved all targets",
    source: family,
    metadata: {
      resolvedTargetCount: telemetry.resolvedTargetCount,
      targetCount: telemetry.targetCount,
      emittedCount: telemetry.emittedCount,
      attemptedCount: telemetry.attemptedCount,
    },
  });
}

function finalizeOptionalRpcTelemetry<T extends { chain: string; symbol: string }>(
  family: string,
  telemetry: OptionalRpcFamilyTelemetry,
  targets: readonly T[],
  accountedTargets: Set<string>,
  emittedCount: number,
  budgetExhausted: boolean,
): void {
  if (budgetExhausted) telemetry.budgetExhausted = true;
  for (const target of targets) {
    const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
    if (!accountedTargets.has(targetLabel)) {
      recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "budget-exhausted");
      accountedTargets.add(targetLabel);
    }
  }

  telemetry.emittedCount = emittedCount;
  logOptionalRpcTelemetry(family, telemetry);
}

export interface OnChainRateValue {
  rate: number;
  /** Measured venue TVL from optional config.tvlRead; null/absent when unmeasured. */
  sourceTvlUsd?: number | null;
}

export interface OnChainRateResult {
  rates: Map<string, OnChainRateValue>;
  failureBreakdown: Record<string, number> | null;
  attemptedCount?: number;
  allDeterministicFailed?: boolean;
  explorerAttemptedCount?: number;
  explorerResolvedCount?: number;
}

type OnChainRateFailureStatus =
  | "no-rpc|etherscan-empty"
  | "no-rpc|etherscan-unavailable"
  | "rpc-empty|etherscan-empty"
  | "rpc-empty|etherscan-unavailable";

type OnChainRateFetchResult =
  | {
      id: string;
      rate: number;
      sourceTvlUsd: number | null;
      status: "ok";
      resolvedVia: "rpc" | "etherscan";
      explorerAttempted: boolean;
    }
  | { id: string; status: OnChainRateFailureStatus; explorerAttempted: boolean };

function buildOnChainFailureStatus(
  rpcStatus: "no-rpc" | "rpc-empty",
  etherscanStatus: "etherscan-empty" | "etherscan-unavailable",
): OnChainRateFailureStatus {
  return `${rpcStatus}|${etherscanStatus}` as OnChainRateFailureStatus;
}

function buildOnChainRateRpcUrls(rpc?: ChainRpcConfig): string[] {
  return resolveRpcUrls(rpc, { order: "fallback-first" });
}

const ERC4626_TOTAL_ASSETS_SELECTOR = "0x01e1d114";

async function readOptionalErc4626TotalAssetsUsd(params: {
  config: (typeof ON_CHAIN_RATE_CONFIGS)[number];
  rpcUrl?: string;
  etherscanApiKey?: string | null;
  signal?: AbortSignal;
}): Promise<number | null> {
  const tvlRead = params.config.tvlRead;
  if (!tvlRead || tvlRead.kind !== "erc4626-total-assets") return null;

  try {
    let raw: bigint | null = null;
    if (params.rpcUrl) {
      raw = await fetchEvmUint256AtBlock(
        undefined,
        params.config.contract,
        ERC4626_TOTAL_ASSETS_SELECTOR,
        "latest",
        {
          extraRpcUrls: [params.rpcUrl],
          signal: params.signal,
          timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
        },
      );
    }

    if (raw == null) {
      const evmChainId = CHAIN_META[params.config.chain]?.evmChainId;
      if (typeof evmChainId === "number" && params.etherscanApiKey) {
        raw = await fetchEtherscanUint256AtBlock(
          evmChainId,
          params.config.contract,
          ERC4626_TOTAL_ASSETS_SELECTOR,
          "latest",
          {
            apiKey: params.etherscanApiKey,
            signal: params.signal,
            timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
          },
        );
      }
    }

    if (raw == null || raw <= 0n) return null;
    const sourceTvlUsd = finiteDecimalNumberFromBigInt(raw, tvlRead.decimals);
    if (sourceTvlUsd == null || !Number.isFinite(sourceTvlUsd) || sourceTvlUsd <= 0) return null;
    return sourceTvlUsd;
  } catch (err) {
    if (params.signal?.aborted) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return null;
  }
}


async function fetchSingleOnChainRate(
  config: (typeof ON_CHAIN_RATE_CONFIGS)[number],
  rpc: ChainRpcConfig | undefined,
  etherscanApiKey?: string | null,
  signal?: AbortSignal,
): Promise<OnChainRateFetchResult> {
  const callData = config.selector + encodeUint256(BigInt(config.inputAmount));
  const rpcUrls = buildOnChainRateRpcUrls(rpc);
  const rpcStatus: "no-rpc" | "rpc-empty" = rpcUrls.length === 0 ? "no-rpc" : "rpc-empty";

  for (const rpcUrl of rpcUrls) {
    try {
      const raw = await fetchEvmUint256AtBlock(undefined, config.contract, callData, "latest", {
        extraRpcUrls: [rpcUrl],
        signal,
        timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
      });
      if (raw == null) continue;
      const sourceTvlUsd = await readOptionalErc4626TotalAssetsUsd({
        config,
        rpcUrl,
        etherscanApiKey,
        signal,
      });
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
        sourceTvlUsd,
        status: "ok",
        resolvedVia: "rpc",
        explorerAttempted: false,
      };
    } catch (err) {
      if (signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const evmChainId = CHAIN_META[config.chain]?.evmChainId;
  if (typeof evmChainId !== "number" || !etherscanApiKey) {
    return {
      id: config.stablecoinId,
      status: buildOnChainFailureStatus(rpcStatus, "etherscan-unavailable"),
      explorerAttempted: false,
    };
  }

  try {
    const raw = await fetchEtherscanUint256AtBlock(evmChainId, config.contract, callData, "latest", {
      apiKey: etherscanApiKey,
      signal,
      timeoutMs: ON_CHAIN_RATE_REQUEST_TIMEOUT_MS,
    });
    if (raw != null) {
      const sourceTvlUsd = await readOptionalErc4626TotalAssetsUsd({
        config,
        etherscanApiKey,
        signal,
      });
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
        sourceTvlUsd,
        status: "ok",
        resolvedVia: "etherscan",
        explorerAttempted: true,
      };
    }
  } catch (err) {
    if (signal?.aborted) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return {
    id: config.stablecoinId,
    status: buildOnChainFailureStatus(rpcStatus, "etherscan-empty"),
    explorerAttempted: true,
  };
}

export async function fetchOnChainRates(
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  etherscanApiKey?: string | null,
): Promise<OnChainRateResult> {
  if (!chainRpcs) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "onchain-rate-rpcs-missing",
      message: "No chain RPCs configured; skipping all on-chain rate fetches",
    });
    const attemptedCount = ON_CHAIN_RATE_CONFIGS.length;
    return {
      rates: new Map(),
      failureBreakdown: { "no-chain-rpcs": attemptedCount },
      attemptedCount,
      allDeterministicFailed: attemptedCount > 0,
    };
  }

  const rateBatchSize = 1;
  const allResults: PromiseSettledResult<OnChainRateFetchResult>[] = [];
  for (let i = 0; i < ON_CHAIN_RATE_CONFIGS.length; i += rateBatchSize) {
    const batch = ON_CHAIN_RATE_CONFIGS.slice(i, i + rateBatchSize);
    const tasks = batch.map(async (config): Promise<OnChainRateFetchResult> => {
      const rpc = getChainRpc(chainRpcs, config.chain);
      return fetchSingleOnChainRate(config, rpc, etherscanApiKey, signal);
    });
    const batchSettled = await Promise.allSettled(tasks);
    allResults.push(...batchSettled);
  }

  const rates = new Map<string, OnChainRateValue>();
  const failureCounts: Record<string, number> = {};
  let explorerAttemptedCount = 0;
  let explorerResolvedCount = 0;

  for (const result of allResults) {
    const val = result.status === "fulfilled" ? result.value : { id: "unknown", status: "rejected" as const };
    if ("rate" in val && val.status === "ok") {
      rates.set(val.id, {
        rate: val.rate,
        sourceTvlUsd: val.sourceTvlUsd,
      });
      if (val.explorerAttempted) explorerAttemptedCount += 1;
      if (val.resolvedVia === "etherscan") explorerResolvedCount += 1;
    } else {
      if (result.status === "fulfilled" && result.value.explorerAttempted) {
        explorerAttemptedCount += 1;
      }
      failureCounts[val.status] = (failureCounts[val.status] ?? 0) + 1;
    }
  }

  const totalFailures = Object.values(failureCounts).reduce((s, n) => s + n, 0);
  if (totalFailures > 0) {
    const breakdown = Object.entries(failureCounts).map(([k, v]) => `${k}=${v}`).join(", ");
    logWorkerEvent({
      scope: "lib",
      job: "sync-yield-data",
      level: "warn",
      event: "onchain-rate-fetches-partial",
      message: "On-chain rate fetches partially failed",
      metadata: {
        resolvedRateCount: rates.size,
        configuredRateCount: ON_CHAIN_RATE_CONFIGS.length,
        failureBreakdown: breakdown,
        failureCounts,
      },
    });
  }

  const attemptedCount = ON_CHAIN_RATE_CONFIGS.length;
  return {
    rates,
    failureBreakdown: totalFailures > 0 ? failureCounts : null,
    attemptedCount,
    allDeterministicFailed: attemptedCount > 0 && rates.size === 0 && totalFailures >= attemptedCount,
    explorerAttemptedCount,
    explorerResolvedCount,
  };
}

const COMPOUND_V3_GET_UTILIZATION = "0x7eb71131";
const COMPOUND_V3_GET_SUPPLY_RATE = "0xd955759d";
const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const SECONDS_PER_YEAR = 31_536_000;

function inferStablecoinDecimals(symbol: string): number {
  return symbol.toUpperCase() === "USDC" || symbol.toUpperCase() === "USDT" ? 6 : 18;
}

export interface CompoundV3SupplyRateResult {
  results: Array<{ stablecoinId: string; yield: ResolvedYield }>;
  telemetry: OptionalRpcFamilyTelemetry;
}

export async function fetchCompoundV3SupplyRates(
  targets: Array<{ stablecoinId: string; chain: string; comet: string; symbol: string }>,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<CompoundV3SupplyRateResult> {
  const results: Array<{ stablecoinId: string; yield: ResolvedYield }> = [];
  const telemetry = createOptionalRpcFamilyTelemetry(targets.length);
  const accountedTargets = new Set<string>();
  const budget = createOptionalSourceBudget("Compound V3 supply rates", OPTIONAL_PROTOCOL_RPC_BUDGET_MS, signal);
  try {
    for (const [index, target] of targets.entries()) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (budget.budgetController.signal.aborted) {
        telemetry.budgetExhausted = true;
        break;
      }
      try {
        const rpc = getChainRpc(chainRpcs ?? new Map(), target.chain);
        const extraRpcUrls = buildOptionalRpcUrls(rpc, index);
        if (extraRpcUrls.length === 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-rpc-config");
          accountedTargets.add(targetLabel);
          continue;
        }

        telemetry.attemptedCount += 1;
        const opts = {
          extraRpcUrls,
          signal: budget.signal,
          timeoutMs: OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS,
          maxRetries: OPTIONAL_PROTOCOL_RPC_MAX_RETRIES,
        };

        const utilization = await fetchEvmUint256AtBlock(target.chain, target.comet, COMPOUND_V3_GET_UTILIZATION, "latest", opts);
        if (utilization == null) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "utilization-unavailable");
          accountedTargets.add(targetLabel);
          continue;
        }

        const supplyRateData = COMPOUND_V3_GET_SUPPLY_RATE + encodeUint256(utilization);
        const perSecondRate = await fetchEvmUint256AtBlock(target.chain, target.comet, supplyRateData, "latest", opts);
        if (perSecondRate == null || perSecondRate === 0n) {
          recordOptionalRpcMiss(
            telemetry,
            target.chain,
            targetLabel,
            perSecondRate === 0n ? "zero-supply-rate" : "supply-rate-unavailable",
          );
          accountedTargets.add(targetLabel);
          continue;
        }

        const ratePerSecond = finiteDecimalNumberFromBigInt(perSecondRate, 18);
        if (ratePerSecond == null) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "supply-rate-overflow");
          accountedTargets.add(targetLabel);
          continue;
        }
        const apy = (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
        if (!Number.isFinite(apy) || apy <= 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
          accountedTargets.add(targetLabel);
          continue;
        }

        const totalSupplyRaw = await fetchEvmUint256AtBlock(
          target.chain,
          target.comet,
          ERC20_TOTAL_SUPPLY_SELECTOR,
          "latest",
          opts,
        );
        if (totalSupplyRaw == null || totalSupplyRaw === 0n) {
          recordOptionalRpcMiss(
            telemetry,
            target.chain,
            targetLabel,
            totalSupplyRaw === 0n ? "zero-tvl" : "tvl-unavailable",
          );
          accountedTargets.add(targetLabel);
          continue;
        }
        const sourceTvlUsd = finiteDecimalNumberFromBigInt(totalSupplyRaw, inferStablecoinDecimals(target.symbol));
        if (sourceTvlUsd == null || sourceTvlUsd <= 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "invalid-tvl");
          accountedTargets.add(targetLabel);
          continue;
        }

        results.push({
          stablecoinId: target.stablecoinId,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: target.comet, sourceTvlUsd, dataSource: "protocol-api",
            exchangeRate: null,
            sourceKey: `protocol-api:compound-v3-supply:${target.chain}:${target.comet.toLowerCase()}`,
            yieldSource: `Compound V3 (${target.chain})`,
            yieldType: "lending-opportunity",
            sourceObservedAt: Math.floor(Date.now() / 1000),
            comparisonAnchorObservedAt: null,
          },
        });
        telemetry.resolvedTargetCount += 1;
        accountedTargets.add(targetLabel);
      } catch (error) {
        if (signal?.aborted) throw error instanceof Error ? error : new Error(String(error));
        if (budget.budgetController.signal.aborted) {
          telemetry.budgetExhausted = true;
          logWorkerEvent({
            scope: "lib",
            job: "sync-yield-data",
            level: "warn",
            event: "compound-v3-budget-exhausted",
            message: "Compound V3 budget exhausted; keeping partial results",
            metadata: { resultCount: results.length },
          });
          break;
        }
        logWorkerEvent({
          scope: "lib",
          job: "sync-yield-data",
          level: "warn",
          event: "compound-v3-target-failed",
          message: "Compound V3 target failed",
          metadata: { chain: target.chain, symbol: target.symbol },
          error,
        });
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
        accountedTargets.add(targetLabel);
      }
    }

    finalizeOptionalRpcTelemetry(
      "compound-v3",
      telemetry,
      targets,
      accountedTargets,
      results.length,
      budget.budgetController.signal.aborted,
    );
    return { results, telemetry };
  } finally {
    budget.cleanup();
  }
}

const AAVE_V3_POOL_ADDRESSES: Record<string, string> = {
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
};
const AAVE_GET_RESERVE_DATA_SELECTOR = "0x35ea6a75";
const AAVE_RESERVE_DATA_CURRENT_LIQUIDITY_RATE_WORD = 2;
const AAVE_RESERVE_DATA_ATOKEN_ADDRESS_WORD = 8;

function rayToApy(currentLiquidityRate: bigint): number {
  const liquidityRate = finiteDecimalNumberFromBigInt(currentLiquidityRate, 27);
  if (liquidityRate == null) return Number.NaN;
  const ratePerSecond = liquidityRate / SECONDS_PER_YEAR;
  return (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
}

function readAbiWord(strippedHex: string, wordIndex: number): string | null {
  const start = wordIndex * 64;
  const end = start + 64;
  if (strippedHex.length < end) return null;
  return strippedHex.slice(start, end);
}

function readAbiAddress(strippedHex: string, wordIndex: number): string | null {
  const word = readAbiWord(strippedHex, wordIndex);
  if (!word) return null;
  const address = `0x${word.slice(24)}`;
  return /^0x[0-9a-fA-F]{40}$/.test(address) && address !== "0x0000000000000000000000000000000000000000"
    ? address
    : null;
}

export interface AaveV3RateTarget {
  stablecoinId: string;
  symbol: string;
  chain: string;
  assetAddress: string;
  assetDecimals?: number;
}

export interface AaveV3SupplyRateRow {
  stablecoinId: string;
  symbol: string;
  chain: string;
  assetAddress: string;
  apy: number;
  sourceTvlUsd: number;
}

export interface AaveV3RateResult {
  results: AaveV3SupplyRateRow[];
  telemetry: OptionalRpcFamilyTelemetry;
}

export async function fetchAaveV3SupplyRates(
  targets: AaveV3RateTarget[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<AaveV3RateResult> {
  const results: AaveV3SupplyRateRow[] = [];
  const telemetry = createOptionalRpcFamilyTelemetry(targets.length);
  const accountedTargets = new Set<string>();
  const resolvedTargets = new Set<string>();

  if (!chainRpcs || targets.length === 0) {
    if (!chainRpcs && targets.length > 0) {
      for (const target of targets) {
        const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-chain-rpcs");
      }
    }
    logOptionalRpcTelemetry("aave-v3", telemetry);
    return { results, telemetry };
  }

  const budget = createOptionalSourceBudget("Aave V3 supply rates", OPTIONAL_PROTOCOL_RPC_BUDGET_MS, signal);
  const aaveBatchSize = 2;

  try {
    for (let i = 0; i < targets.length; i += aaveBatchSize) {
      if (budget.budgetController.signal.aborted) {
        telemetry.budgetExhausted = true;
        break;
      }
      const batch = targets.slice(i, i + aaveBatchSize);
      await Promise.all(
        batch.map(async (target, batchIndex) => {
          const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
          if (budget.budgetController.signal.aborted) {
            telemetry.budgetExhausted = true;
            return;
          }
          const poolAddress = AAVE_V3_POOL_ADDRESSES[target.chain];
          if (!poolAddress) {
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "unsupported-pool-chain");
            accountedTargets.add(targetLabel);
            return;
          }

          const rpc = getChainRpc(chainRpcs, target.chain);
          const rpcUrls = buildOptionalRpcUrls(rpc, i + batchIndex);
          if (rpcUrls.length === 0) {
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "no-rpc-config");
            accountedTargets.add(targetLabel);
            return;
          }

          const callData =
            AAVE_GET_RESERVE_DATA_SELECTOR +
            encodeAddress(target.assetAddress);

          try {
            telemetry.attemptedCount += 1;
            const hex = await fetchEvmCallHexAtBlock(target.chain, poolAddress, callData, "latest", {
              extraRpcUrls: rpcUrls,
              signal: budget.signal,
              timeoutMs: OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS,
              maxRetries: OPTIONAL_PROTOCOL_RPC_MAX_RETRIES,
            });

            if (!hex || hex.length < 2) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "reserve-data-unavailable");
              accountedTargets.add(targetLabel);
              return;
            }

            const stripped = hex.slice(2);
            const liquidityRateHex = readAbiWord(stripped, AAVE_RESERVE_DATA_CURRENT_LIQUIDITY_RATE_WORD);
            if (!liquidityRateHex) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "reserve-data-short");
              accountedTargets.add(targetLabel);
              return;
            }

            const currentLiquidityRate = BigInt("0x" + liquidityRateHex);
            const apy = rayToApy(currentLiquidityRate);
            if (!Number.isFinite(apy) || apy <= 0) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
              accountedTargets.add(targetLabel);
              return;
            }

            const aTokenAddress = readAbiAddress(stripped, AAVE_RESERVE_DATA_ATOKEN_ADDRESS_WORD);
            if (!aTokenAddress) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "atoken-address-unavailable");
              accountedTargets.add(targetLabel);
              return;
            }
            const aTokenSupplyRaw = await fetchEvmUint256AtBlock(
              target.chain,
              aTokenAddress,
              ERC20_TOTAL_SUPPLY_SELECTOR,
              "latest",
              {
                extraRpcUrls: rpcUrls,
                signal: budget.signal,
                timeoutMs: OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS,
                maxRetries: OPTIONAL_PROTOCOL_RPC_MAX_RETRIES,
              },
            );
            if (aTokenSupplyRaw == null || aTokenSupplyRaw === 0n) {
              recordOptionalRpcMiss(
                telemetry,
                target.chain,
                targetLabel,
                aTokenSupplyRaw === 0n ? "zero-tvl" : "tvl-unavailable",
              );
              accountedTargets.add(targetLabel);
              return;
            }
            const sourceTvlUsd = finiteDecimalNumberFromBigInt(
              aTokenSupplyRaw,
              target.assetDecimals ?? inferStablecoinDecimals(target.symbol),
            );
            if (sourceTvlUsd == null || sourceTvlUsd <= 0) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "invalid-tvl");
              accountedTargets.add(targetLabel);
              return;
            }

            results.push({
              stablecoinId: target.stablecoinId,
              symbol: target.symbol,
              chain: target.chain,
              assetAddress: target.assetAddress,
              apy,
              sourceTvlUsd,
            });
            resolvedTargets.add(targetLabel);
            telemetry.resolvedTargetCount = resolvedTargets.size;
            accountedTargets.add(targetLabel);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            if (budget.budgetController.signal.aborted) {
              telemetry.budgetExhausted = true;
              return;
            }
            logWorkerEvent({
              scope: "lib",
              job: "sync-yield-data",
              level: "warn",
              event: "aave-v3-reserve-fetch-failed",
              message: "Failed to fetch Aave V3 reserve data",
              source: "aave-v3",
              metadata: { chain: target.chain, symbol: target.symbol },
              error: toErrorMessage(err),
            });
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
            accountedTargets.add(targetLabel);
          }
        }),
      );
    }

    finalizeOptionalRpcTelemetry(
      "aave-v3",
      telemetry,
      targets,
      accountedTargets,
      results.length,
      budget.budgetController.signal.aborted,
    );
    return { results, telemetry };
  } finally {
    budget.cleanup();
  }
}
