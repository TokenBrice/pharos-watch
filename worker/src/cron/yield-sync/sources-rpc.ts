import { CHAIN_META } from "@shared/lib/chains";
import { getChainRpc, type ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEtherscanUint256AtBlock,
  fetchEvmCallHexAtBlock,
  fetchEvmUint256AtBlock,
} from "../../lib/evm-rpc";
import { createOptionalSourceBudget } from "./sources-helpers";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config";
import type { ResolvedYield } from "./types";

const OPTIONAL_PROTOCOL_RPC_BUDGET_MS = 30_000;
const OPTIONAL_PROTOCOL_RPC_REQUEST_TIMEOUT_MS = 10_000;
const OPTIONAL_PROTOCOL_RPC_MAX_RETRIES = 2;
const ON_CHAIN_RATE_REQUEST_TIMEOUT_MS = 6_000;

export interface OptionalRpcFamilyTelemetry {
  targetCount: number;
  attemptedCount: number;
  resolvedTargetCount: number;
  emittedCount: number;
  missingTargetCount: number;
  missingByChain: Record<string, number>;
  missingReasonCounts: Record<string, number>;
  missingTargets: string[];
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
  telemetry.missingTargets.push(targetLabel);
}

function buildOptionalRpcUrls(rpc: ChainRpcConfig | undefined, rotationSeed = 0): string[] {
  if (!rpc) return [];
  const primary = typeof rpc.rpcUrl === "string" && rpc.rpcUrl.length > 0 ? rpc.rpcUrl : null;
  const fallback =
    typeof rpc.fallbackRpcUrl === "string" && rpc.fallbackRpcUrl.length > 0 ? rpc.fallbackRpcUrl : null;
  const ordered = rotationSeed % 2 === 0 ? [fallback, primary] : [primary, fallback];
  return Array.from(new Set(ordered.filter((url): url is string => typeof url === "string" && url.length > 0)));
}

function logOptionalRpcTelemetry(family: string, telemetry: OptionalRpcFamilyTelemetry): void {
  const reasonSummary = Object.entries(telemetry.missingReasonCounts)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");

  if (telemetry.missingTargetCount > 0 || telemetry.budgetExhausted) {
    console.warn(
      `[yield/${family}] resolved ${telemetry.resolvedTargetCount}/${telemetry.targetCount} targets `
      + `(emitted ${telemetry.emittedCount}, attempted ${telemetry.attemptedCount}; ${reasonSummary || "no-miss-reasons"})`,
    );
    return;
  }

  console.log(
    `[yield/${family}] resolved ${telemetry.resolvedTargetCount}/${telemetry.targetCount} targets `
    + `(emitted ${telemetry.emittedCount}, attempted ${telemetry.attemptedCount})`,
  );
}

export interface OnChainRateResult {
  rates: Map<string, { rate: number }>;
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
  if (!rpc) return [];
  const urls = [rpc.fallbackRpcUrl, rpc.rpcUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  return Array.from(new Set(urls));
}

async function fetchSingleOnChainRate(
  config: (typeof ON_CHAIN_RATE_CONFIGS)[number],
  rpc: ChainRpcConfig | undefined,
  etherscanApiKey?: string | null,
  signal?: AbortSignal,
): Promise<OnChainRateFetchResult> {
  const callData = config.selector + config.inputAmount.replace("0x", "").padStart(64, "0");
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
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
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
      return {
        id: config.stablecoinId,
        rate: Number(raw) / 10 ** config.decimals,
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
    console.warn("[yield] No chain RPCs configured, skipping all on-chain rate fetches");
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

  const rates = new Map<string, { rate: number }>();
  const failureCounts: Record<string, number> = {};
  let explorerAttemptedCount = 0;
  let explorerResolvedCount = 0;

  for (const result of allResults) {
    const val = result.status === "fulfilled" ? result.value : { id: "unknown", status: "rejected" as const };
    if ("rate" in val && val.status === "ok") {
      rates.set(val.id, { rate: val.rate });
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
    console.warn(`[yield] On-chain rates: ${rates.size}/${ON_CHAIN_RATE_CONFIGS.length} ok (${breakdown})`);
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
const SECONDS_PER_YEAR = 31_536_000;

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

        const supplyRateData = COMPOUND_V3_GET_SUPPLY_RATE + utilization.toString(16).padStart(64, "0");
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

        const ratePerSecond = Number(perSecondRate) / 1e18;
        const apy = (Math.pow(1 + ratePerSecond, SECONDS_PER_YEAR) - 1) * 100;
        if (!Number.isFinite(apy) || apy <= 0) {
          recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
          accountedTargets.add(targetLabel);
          continue;
        }

        results.push({
          stablecoinId: target.stablecoinId,
          yield: {
            currentApy: apy, apyBase: apy, apyReward: null,
            sourcePool: null, sourceTvlUsd: null, dataSource: "protocol-api",
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
          console.warn(`[yield] Compound V3 budget exhausted; keeping ${results.length} partial results`);
          break;
        }
        console.warn(`[yield] Compound V3 ${target.chain}:${target.symbol} failed:`, error);
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
        accountedTargets.add(targetLabel);
      }
    }

    if (budget.budgetController.signal.aborted) telemetry.budgetExhausted = true;
    for (const target of targets) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (!accountedTargets.has(targetLabel)) {
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "budget-exhausted");
        accountedTargets.add(targetLabel);
      }
    }

    telemetry.emittedCount = results.length;
    logOptionalRpcTelemetry("compound-v3", telemetry);
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
const RAY = 10n ** 27n;

function rayToApy(currentLiquidityRate: bigint): number {
  const ratePerSecond = Number(currentLiquidityRate) / Number(RAY) / 31536000;
  return (Math.pow(1 + ratePerSecond, 31536000) - 1) * 100;
}

export interface AaveV3RateTarget {
  stablecoinId: string;
  symbol: string;
  chain: string;
  assetAddress: string;
}

export interface AaveV3RateResult {
  rates: Map<string, { apy: number; chain: string }>;
  telemetry: OptionalRpcFamilyTelemetry;
}

export async function fetchAaveV3SupplyRates(
  targets: AaveV3RateTarget[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<AaveV3RateResult> {
  const rates = new Map<string, { apy: number; chain: string }>();
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
    telemetry.emittedCount = rates.size;
    logOptionalRpcTelemetry("aave-v3", telemetry);
    return { rates, telemetry };
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
            target.assetAddress.replace("0x", "").toLowerCase().padStart(64, "0");

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
            if (stripped.length < 192) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "reserve-data-short");
              accountedTargets.add(targetLabel);
              return;
            }

            const liquidityRateHex = stripped.slice(128, 192);
            const currentLiquidityRate = BigInt("0x" + liquidityRateHex);
            const apy = rayToApy(currentLiquidityRate);
            if (!Number.isFinite(apy) || apy <= 0) {
              recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "non-positive-apy");
              accountedTargets.add(targetLabel);
              return;
            }

            const existing = rates.get(target.stablecoinId);
            if (!existing || apy > existing.apy) {
              rates.set(target.stablecoinId, { apy, chain: target.chain });
            }
            resolvedTargets.add(targetLabel);
            telemetry.resolvedTargetCount = resolvedTargets.size;
            accountedTargets.add(targetLabel);
          } catch (err) {
            if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
            if (budget.budgetController.signal.aborted) {
              telemetry.budgetExhausted = true;
              return;
            }
            console.warn(
              `[yield/aave-v3] Failed to fetch reserve data for ${target.symbol} on ${target.chain}:`,
              err instanceof Error ? err.message : String(err),
            );
            recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "rpc-exception");
            accountedTargets.add(targetLabel);
          }
        }),
      );
    }

    if (budget.budgetController.signal.aborted) telemetry.budgetExhausted = true;
    for (const target of targets) {
      const targetLabel = buildOptionalRpcTargetLabel(target.chain, target.symbol);
      if (!accountedTargets.has(targetLabel)) {
        recordOptionalRpcMiss(telemetry, target.chain, targetLabel, "budget-exhausted");
        accountedTargets.add(targetLabel);
      }
    }

    telemetry.emittedCount = rates.size;
    logOptionalRpcTelemetry("aave-v3", telemetry);
    return { rates, telemetry };
  } finally {
    budget.cleanup();
  }
}
