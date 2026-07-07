import type { MintBurnTxContext } from "../../lib/mint-burn-bridge-classifier";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { budgetExhausted } from "../../lib/evm-logs";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour, MintBurnPriceContext } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnContractConfig, MintBurnTier } from "../../lib/mint-burn-contracts";
import { deferConfig, loadDeferredConfigs, shouldDeferConfig } from "./run-state";
import { createMintBurnConfigSummary, syncMintBurnConfig, type MintBurnConfigSummary } from "./sync-config";

const MINT_BURN_RUNTIME_BUDGET_MS = 9 * 60_000;
const MINT_BURN_MIN_CONFIG_WINDOW_MS = 60_000;

function configCoverageRatio(summary: MintBurnConfigSummary): number | null {
  if (summary.eventCoverage.length === 0) return null;
  const okCount = summary.eventCoverage.filter((c) => c.status === "ok").length;
  return okCount / summary.eventCoverage.length;
}

export function configKey(config: MintBurnContractConfig): string {
  return mintBurnConfigKey(config);
}

export function configTier(config: MintBurnContractConfig): MintBurnTier {
  return config.tier ?? "critical";
}

export interface MintBurnRunConfigPhaseResult {
  rowsRead: number;
  rowsParsed: number;
  rowsInserted: number;
  rowsIgnored: number;
  rowsDropped: number;
  contractsProcessed: number;
  contractsSkipped: number;
  contractsDeferredExtended: number;
  apiErrors: number;
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
  atomicRoundtripsTotal: number;
  txContextShortfalls: number;
  bridgeClassificationDeferredRows: number;
  criticalContractsSatisfied: number;
  criticalContractsUnsatisfied: number;
  configBreakdown: MintBurnConfigSummary[];
  runtimeBudgetHit: boolean;
}

export async function runMintBurnConfigPhase(input: {
  db: D1Database;
  configs: MintBurnContractConfig[];
  lane: "all" | "critical" | "extended";
  jobName: string;
  reportProgress?: CronProgressReporter;
  budget: { limit: number; count: number };
  chainContexts: Map<string, {
    chainHead: number;
    alchemyUrl: string;
    chainTimestampCache: Map<number, number>;
    txContextCache: Map<string, MintBurnTxContext | null>;
  }>;
  signal?: AbortSignal;
  runTimestamp: number;
  priceContext: MintBurnPriceContext;
  lastBlocksAfterRun: Map<string, number>;
  maxScanRange: number;
  criticalConfigBudgetLimit: number;
  criticalBridgeConfigBudgetLimit?: number;
  extendedConfigBudgetLimit: number;
  evmSafetyMarginBlocks: number;
  affectedHours: Map<string, MintBurnAffectedHour>;
  deadlineMs?: number;
  minimumConfigWindowMs?: number;
}): Promise<MintBurnRunConfigPhaseResult> {
  let rowsRead = 0;
  let rowsParsed = 0;
  let rowsInserted = 0;
  let rowsIgnored = 0;
  let rowsDropped = 0;
  let contractsProcessed = 0;
  let contractsSkipped = 0;
  let contractsDeferredExtended = 0;
  let apiErrors = 0;
  let effectiveBurns = 0;
  let bridgeBurns = 0;
  let reviewBurns = 0;
  let atomicRoundtripsTotal = 0;
  let txContextShortfalls = 0;
  let bridgeClassificationDeferredRows = 0;
  let criticalContractsSatisfied = 0;
  let criticalContractsUnsatisfied = 0;
  let runtimeBudgetHit = false;

  const configBreakdown: MintBurnConfigSummary[] = [];
  const affectedHours = input.affectedHours;
  const deadlineMs = input.deadlineMs ?? Date.now() + MINT_BURN_RUNTIME_BUDGET_MS;
  const minimumConfigWindowMs = input.minimumConfigWindowMs ?? MINT_BURN_MIN_CONFIG_WINDOW_MS;

  const nowSec = Math.floor(Date.now() / 1000);
  const deferredKeys = await loadDeferredConfigs(input.db, nowSec);

  for (let i = 0; i < input.configs.length; i++) {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("sync-mint-burn aborted");
    }

    if (
      Date.now() + minimumConfigWindowMs >= deadlineMs
    ) {
      runtimeBudgetHit = true;
      for (let remainingIndex = i; remainingIndex < input.configs.length; remainingIndex++) {
        const remainingConfig = input.configs[remainingIndex]!;
        const remainingKey = configKey(remainingConfig);
        const remainingTier = configTier(remainingConfig);
        const remainingSummary = createMintBurnConfigSummary(remainingConfig, remainingKey, remainingTier);
        remainingSummary.skippedReason = "runtime-budget-exhausted";
        contractsSkipped++;
        if (remainingTier === "critical") {
          criticalContractsUnsatisfied++;
        }
        configBreakdown.push(remainingSummary);
      }
      break;
    }

    const config = input.configs[i]!;
    const key = configKey(config);
    const tier = configTier(config);
    const summary = createMintBurnConfigSummary(config, key, tier);

    await reportCronProgress(input.reportProgress, {
      stage: "scan-config",
      itemsDone: i,
      itemsTotal: input.configs.length,
      message: `Scanning ${config.symbol} on ${config.chain.chainName}`,
      metadata: {
        lane: input.lane,
        jobName: input.jobName,
        configKey: key,
        symbol: config.symbol,
        tier,
      },
    }, input.budget);

    const finalizeSummary = (criticalOutcome: "satisfied" | "unsatisfied" | "n/a" = "n/a"): void => {
      if (tier === "critical") {
        if (criticalOutcome === "satisfied") {
          criticalContractsSatisfied++;
        } else if (criticalOutcome === "unsatisfied") {
          criticalContractsUnsatisfied++;
        }
      }
      configBreakdown.push(summary);
    };

    if (deferredKeys.has(key)) {
      summary.skippedReason = "deferred";
      contractsSkipped++;
      finalizeSummary();
      continue;
    }

    if (budgetExhausted(input.budget)) {
      summary.skippedReason = "global-budget-exhausted";
      contractsSkipped++;
      finalizeSummary("unsatisfied");
      continue;
    }

    const remainingCritical = input.configs
      .slice(i)
      .filter((next) => configTier(next) === "critical").length;
    const remainingBudget = input.budget.limit - input.budget.count;
    const shouldDeferExtended = tier === "extended" && remainingBudget <= Math.max(10, remainingCritical * 6);
    if (shouldDeferExtended) {
      summary.skippedReason = "extended-deferred-under-pressure";
      contractsDeferredExtended++;
      contractsSkipped++;
      finalizeSummary();
      continue;
    }

    const chainContext = input.chainContexts.get(config.chain.chainId);
    if (!chainContext) {
      summary.skippedReason = "missing-chain-context";
      contractsSkipped++;
      finalizeSummary("unsatisfied");
      continue;
    }

    const fromBlock = (input.lastBlocksAfterRun.get(key) ?? (config.startBlock - 1)) + 1;
    if (fromBlock > chainContext.chainHead) {
      summary.skippedReason = "up-to-date";
      contractsSkipped++;
      finalizeSummary("satisfied");
      continue;
    }

    summary.attempted = true;
    contractsProcessed++;
    const scanTo = Math.min(fromBlock + input.maxScanRange - 1, chainContext.chainHead);
    const tierBudgetLimit =
      tier === "critical" && config.bridgeDetection
        ? input.criticalBridgeConfigBudgetLimit ?? input.criticalConfigBudgetLimit
        : tier === "critical"
          ? input.criticalConfigBudgetLimit
          : input.extendedConfigBudgetLimit;
    const configBudgetLimit = Math.max(
      1,
      Math.min(
        input.budget.limit - input.budget.count,
        tierBudgetLimit,
      ),
    );
    const result = await syncMintBurnConfig({
      db: input.db,
      config,
      key,
      tier,
      fromBlock,
      scanTo,
      chainHead: chainContext.chainHead,
      alchemyUrl: chainContext.alchemyUrl,
      signal: input.signal,
      configBudgetLimit,
      runTimestamp: input.runTimestamp,
      priceContext: input.priceContext,
      chainTimestampCache: chainContext.chainTimestampCache,
      txContextCache: chainContext.txContextCache,
      affectedHours,
      safetyMarginBlocks: input.evmSafetyMarginBlocks,
      deadlineMs,
    });
    Object.assign(summary, result.summary);

    rowsRead += summary.rowsRead;
    rowsParsed += summary.rowsParsed;
    rowsInserted += summary.rowsInserted;
    rowsIgnored += summary.rowsIgnored;
    rowsDropped += summary.rowsDropped;
    apiErrors += result.apiErrors;
    effectiveBurns += result.effectiveBurns;
    bridgeBurns += result.bridgeBurns;
    reviewBurns += result.reviewBurns;
    atomicRoundtripsTotal += result.atomicRoundtripsDetected;
    txContextShortfalls += summary.txContextShortfalls;
    bridgeClassificationDeferredRows += summary.bridgeClassificationDeferredRows;

    if (result.newLastBlock != null) {
      const previousLastBlock = input.lastBlocksAfterRun.get(key) ?? (config.startBlock - 1);
      const nextLastBlock = Math.max(previousLastBlock, result.newLastBlock);
      await upsertMintBurnSyncState(input.db, key, nextLastBlock, "monotonic-max");
      input.lastBlocksAfterRun.set(key, nextLastBlock);
    }
    input.budget.count += summary.requestBudgetUsed;

    console.log(
      `[sync-mint-burn] ${config.symbol} on ${config.chain.chainName}: ` +
      `${summary.rowsInserted} inserted, ${summary.rowsIgnored} ignored, ` +
      `scan ${fromBlock}-${summary.scanTo ?? scanTo}, advancedTo=${summary.advancedTo ?? "none"}`,
    );

    const configCoverage = configCoverageRatio(summary);
    if (shouldDeferConfig(result.apiErrors, configCoverage)) {
      try {
        await deferConfig(
          input.db,
          key,
          nowSec,
          result.apiErrors,
          configCoverage,
          "api-errors-and-low-coverage",
        );
      } catch (error) {
        console.warn(
          `[sync-mint-burn] Failed to record deferral for ${key}:`,
          error,
        );
      }
    }

    finalizeSummary(
      summary.advanceReason === "full-success-events" || summary.advanceReason === "full-success-empty"
        ? "satisfied"
        : "unsatisfied",
    );
  }

  return {
    rowsRead,
    rowsParsed,
    rowsInserted,
    rowsIgnored,
    rowsDropped,
    contractsProcessed,
    contractsSkipped,
    contractsDeferredExtended,
    apiErrors,
    effectiveBurns,
    bridgeBurns,
    reviewBurns,
    atomicRoundtripsTotal,
    txContextShortfalls,
    bridgeClassificationDeferredRows,
    criticalContractsSatisfied,
    criticalContractsUnsatisfied,
    configBreakdown,
    runtimeBudgetHit,
  };
}
