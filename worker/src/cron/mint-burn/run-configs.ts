import { logWorkerEventArgs } from "../../lib/structured-log";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { budgetExhausted } from "../../lib/evm-logs";
import { rethrowIfAborted } from "../../lib/abort";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour, MintBurnPriceContext } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import type { MintBurnContractConfig, MintBurnTier } from "../../lib/mint-burn-contracts";
import { deferConfig, loadActiveConfigDeferrals, shouldDeferConfig } from "./run-state";
import { createMintBurnConfigSummary, type MintBurnConfigSummary } from "./sync-config";
import { mintBurnScanRequestFloor, MINT_BURN_RETRY_BOUNDARY_REQUESTS, syncMintBurnConfigWithRetries } from "./scan-with-retry";
import type { MintBurnChainContext } from "./chain-context";
import type { MintBurnCoverageRepairSummary } from "./repair-coverage";
import {
  conservationOnlyEventDefsFor, fetchConservationBoundaries, getMintBurnConservationEligibility, MINT_BURN_CONSERVATION_PREPASS_MAX_MS,
  type ConservationBoundaryRequest,
} from "../../lib/mint-burn-conservation";

const MINT_BURN_RUNTIME_BUDGET_MS = 9 * 60_000;
const MINT_BURN_MIN_CONFIG_WINDOW_MS = 60_000;
const MINT_BURN_PENDING_MAX_SCAN_RANGE = 500_000;

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

function configScanRange(
  config: MintBurnContractConfig, lastBlock: number | undefined, chainHead: number, maxScanRange: number,
  context: Pick<MintBurnChainContext, "rpcEndpoints" | "endpointHeads">, requestBudgetLimit: number,
  maximizeAffordableRange = false,
) {
  const fromBlock = (lastBlock ?? (config.startBlock - 1)) + 1;
  let scanTo = Math.min(fromBlock + maxScanRange - 1, chainHead);
  if (maximizeAffordableRange) {
    let affordable = fromBlock;
    while (affordable < scanTo) {
      const candidate = affordable + Math.ceil((scanTo - affordable) / 2);
      if (mintBurnScanRequestFloor({ config, fromBlock, scanTo: candidate,
        rpcEndpoints: context.rpcEndpoints, endpointHeads: context.endpointHeads }) <= requestBudgetLimit) {
        affordable = candidate;
      } else scanTo = candidate - 1;
    }
    return { fromBlock, scanTo };
  }
  while (scanTo > fromBlock && mintBurnScanRequestFloor({
    config, fromBlock, scanTo, rpcEndpoints: context.rpcEndpoints, endpointHeads: context.endpointHeads,
  }) > requestBudgetLimit) {
    scanTo = fromBlock + Math.floor((scanTo - fromBlock) / 2);
  }
  return { fromBlock, scanTo };
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
  admittedApiErrors?: number;
  effectiveBurns: number;
  bridgeBurns: number;
  reviewBurns: number;
  atomicRoundtripsTotal: number;
  txContextShortfalls: number;
  bridgeClassificationDeferredRows: number;
  criticalContractsSatisfied: number;
  criticalContractsUnsatisfied: number;
  configBreakdown: MintBurnConfigSummary[];
  activeProviderDeferrals: Map<string, number>;
  runtimeBudgetHit: boolean;
  coverageRepairs?: MintBurnCoverageRepairSummary[];
}

export async function runMintBurnConfigPhase(input: {
  db: D1Database;
  configs: MintBurnContractConfig[];
  pendingAdmissionKeys?: ReadonlySet<string>;
  preparePendingConfigs?: (budget: { limit: number; count: number }) => Promise<void>;
  lane: "all" | "critical" | "extended";
  jobName: string;
  reportProgress?: CronProgressReporter;
  budget: { limit: number; count: number };
  chainContexts: Map<string, MintBurnChainContext>;
  signal?: AbortSignal;
  runTimestamp: number;
  priceContext: MintBurnPriceContext;
  lastBlocksAfterRun: Map<string, number>;
  pendingCursorUpdates: Map<string, number>;
  pendingScanCoverage?: Map<string, MintBurnScanCoverage>;
  maxScanRange: number;
  criticalConfigBudgetLimit: number;
  criticalBridgeConfigBudgetLimit?: number;
  extendedConfigBudgetLimit: number;
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
  let admittedApiErrors = 0;
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
  const isPending = (config: MintBurnContractConfig) => input.pendingAdmissionKeys?.has(configKey(config)) === true;
  const configs = [...input.configs.filter((config) => !isPending(config)), ...input.configs.filter(isPending)];
  const affectedHours = input.affectedHours;
  const deadlineMs = input.deadlineMs ?? Date.now() + MINT_BURN_RUNTIME_BUDGET_MS;
  const minimumConfigWindowMs = input.minimumConfigWindowMs ?? MINT_BURN_MIN_CONFIG_WINDOW_MS;

  const nowSec = Math.floor(Date.now() / 1000);
  const activeProviderDeferrals = await loadActiveConfigDeferrals(input.db, nowSec);
  const deferredKeys = new Set(activeProviderDeferrals.keys());
  const configBudgetLimitFor = (config: MintBurnContractConfig): number =>
    configTier(config) === "critical" && config.bridgeDetection
      ? input.criticalBridgeConfigBudgetLimit ?? input.criticalConfigBudgetLimit
      : configTier(config) === "critical" ? input.criticalConfigBudgetLimit : input.extendedConfigBudgetLimit;
  const scanRanges = new Map<string, { fromBlock: number; scanTo: number }>();
  const boundaryRequests = new Map<string, ConservationBoundaryRequest>();
  for (const config of configs) {
    const key = configKey(config);
    const chainContext = input.chainContexts.get(config.chain.chainId);
    // Pending conservation reads must not spend budget before admitted scans.
    if (isPending(config) || deferredKeys.has(key) || chainContext?.chainHead == null) continue;
    // Plan a fundable initial range before the conservation prepass so its
    // supply boundaries and the subsequent log/proof scan stay identical.
    const range = configScanRange(config, input.lastBlocksAfterRun.get(key), chainContext.chainHead,
      input.maxScanRange, chainContext, configBudgetLimitFor(config));
    scanRanges.set(key, range);
    if (range.fromBlock <= chainContext.chainHead && getMintBurnConservationEligibility(config).supported) {
      boundaryRequests.set(key, { key, config, fromBlock: range.fromBlock, toBlock: range.scanTo });
    }
  }
  const conservationBoundaries = await fetchConservationBoundaries({
    requests: [...boundaryRequests.values()],
    rpcEndpointsByChain: new Map([...input.chainContexts].map(([chainId, context]) => [chainId, context.rpcEndpoints])),
    budget: input.budget,
    checkedAt: nowSec,
    signal: input.signal,
    deadlineMs: Math.min(deadlineMs, Date.now() + MINT_BURN_CONSERVATION_PREPASS_MAX_MS),
  });

  // Reserve log queries for the extended roster, but treat this as a soft
  // capacity target: starving the current scan of timestamps/proof headers
  // creates attempts without progress. Complete scans win over attempt counts.
  const reservedScanRequests = new Array<number>(configs.length + 1).fill(0);
  if (input.lane === "extended") {
    const coverageTarget = Math.ceil(configs.filter((config) => !isPending(config)).length / 2);
    for (let i = coverageTarget - 1; i >= 0; i--) {
      const config = configs[i]!;
      const key = configKey(config);
      const context = input.chainContexts.get(config.chain.chainId);
      const needsScan = !deferredKeys.has(key) && context?.chainHead != null
        && (scanRanges.get(key)?.fromBlock ?? Infinity) <= context.chainHead;
      reservedScanRequests[i] = reservedScanRequests[i + 1]!
        + (needsScan ? config.events.length + conservationOnlyEventDefsFor(config).length : 0);
    }
  }

  let pendingPrepared = false;
  let pendingPreparationFailed = false;
  for (let i = 0; i < configs.length; i++) {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("sync-mint-burn aborted");
    }

    if (isPending(configs[i]!) && !pendingPrepared && !budgetExhausted(input.budget)
      && Date.now() + minimumConfigWindowMs < deadlineMs) {
      try {
        await input.preparePendingConfigs?.(input.budget);
      } catch (error) {
        rethrowIfAborted(error, input.signal);
        pendingPreparationFailed = true;
        // A thrown loader can hide request accounting; stop this pending batch.
        input.budget.count = input.budget.limit;
        logWorkerEventArgs("handler", "warn", "[sync-mint-burn] pending-chain-context-failed", error);
      }
      pendingPrepared = true;
    }

    if (
      Date.now() + minimumConfigWindowMs >= deadlineMs
    ) {
      runtimeBudgetHit = true;
      for (let remainingIndex = i; remainingIndex < configs.length; remainingIndex++) {
        const remainingConfig = configs[remainingIndex]!;
        const remainingKey = configKey(remainingConfig);
        const remainingTier = configTier(remainingConfig);
        const remainingSummary = createMintBurnConfigSummary(remainingConfig, remainingKey, remainingTier);
        remainingSummary.skippedReason = "runtime-budget-exhausted";
        contractsSkipped++;
        if (remainingTier === "critical" && !isPending(remainingConfig)) {
          criticalContractsUnsatisfied++;
        }
        configBreakdown.push(remainingSummary);
      }
      break;
    }

    const config = configs[i]!;
    const key = configKey(config);
    const tier = configTier(config);
    const pending = isPending(config);
    const summary = createMintBurnConfigSummary(config, key, tier);

    await reportCronProgress(input.reportProgress, {
      stage: "scan-config",
      itemsDone: i,
      itemsTotal: configs.length,
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
      if (tier === "critical" && !pending) {
        if (criticalOutcome === "satisfied") {
          criticalContractsSatisfied++;
        } else if (criticalOutcome === "unsatisfied") {
          criticalContractsUnsatisfied++;
        }
      }
      configBreakdown.push(summary);
    };

    const chainContext = input.chainContexts.get(config.chain.chainId);
    if (pending && pendingPreparationFailed) {
      summary.skippedReason = "pending-chain-context-failed";
      summary.errors = 1;
      contractsSkipped++;
      finalizeSummary();
      continue;
    }
    if (chainContext?.chainHead == null) {
      summary.skippedReason = "finality-head-unavailable";
      summary.eventCoverage = config.events.map((eventDef) => ({
        eventDef: `${eventDef.signature}:${eventDef.direction}`,
        status: "finality-head-unavailable",
        complete: false,
        scannedToBlock: (input.lastBlocksAfterRun.get(key) ?? config.startBlock - 1),
        rowsRead: 0,
      }));
      contractsSkipped++;
      finalizeSummary("unsatisfied");
      continue;
    }

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

    const remainingCritical = configs
      .slice(i)
      .filter((next) => configTier(next) === "critical" && !isPending(next)).length;
    const remainingBudget = input.budget.limit - input.budget.count;
    const shouldDeferExtended = tier === "extended" && remainingBudget <= Math.max(10, remainingCritical * 6);
    if (shouldDeferExtended) {
      summary.skippedReason = "extended-deferred-under-pressure";
      contractsDeferredExtended++;
      contractsSkipped++;
      finalizeSummary();
      continue;
    }

    const tierBudgetLimit = configBudgetLimitFor(config);
    const boundaryReserve = pending && getMintBurnConservationEligibility(config).supported
      ? MINT_BURN_RETRY_BOUNDARY_REQUESTS : 0;
    const availableBudget = Math.min(tierBudgetLimit, remainingBudget - (tier === "extended" ? 10 : 0));
    const plannedRange = scanRanges.get(key);
    const currentFromBlock = (input.lastBlocksAfterRun.get(key) ?? (config.startBlock - 1)) + 1;
    const { fromBlock, scanTo } = plannedRange?.fromBlock === currentFromBlock
      && plannedRange.scanTo <= chainContext.chainHead
      ? plannedRange
      : configScanRange(config, input.lastBlocksAfterRun.get(key), chainContext.chainHead,
        pending ? MINT_BURN_PENDING_MAX_SCAN_RANGE : input.maxScanRange, chainContext,
        pending ? Math.max(0, availableBudget - boundaryReserve) : tierBudgetLimit, pending);
    if (fromBlock > chainContext.chainHead) {
      summary.skippedReason = "up-to-date";
      contractsSkipped++;
      finalizeSummary("satisfied");
      continue;
    }
    const scanBudgetInput = { config, fromBlock, scanTo, rpcEndpoints: chainContext.rpcEndpoints,
      endpointHeads: chainContext.endpointHeads };
    const minimumScanRequests = mintBurnScanRequestFloor(scanBudgetInput);
    if (availableBudget < minimumScanRequests + boundaryReserve) {
      summary.skippedReason = tier === "extended" ? "extended-deferred-under-pressure" : "global-budget-exhausted";
      if (tier === "extended") contractsDeferredExtended++;
      contractsSkipped++;
      finalizeSummary(tier === "critical" ? "unsatisfied" : "n/a");
      continue;
    }
    const retryReserve = mintBurnScanRequestFloor({
      ...scanBudgetInput, scanTo: fromBlock + Math.floor((scanTo - fromBlock) / 2),
    }) + (getMintBurnConservationEligibility(config).supported ? MINT_BURN_RETRY_BOUNDARY_REQUESTS : 0);

    summary.attempted = true;
    contractsProcessed++;
    const configBudgetLimit = Math.max(
      1,
      Math.min(
        input.budget.limit - input.budget.count - (tier === "extended" ? 10 : 0),
        tierBudgetLimit,
        input.lane === "extended"
          ? Math.max(minimumScanRequests + retryReserve, input.budget.limit - input.budget.count - 10 - reservedScanRequests[i + 1]!)
          : tierBudgetLimit,
      ),
    );
    const boundaryRequest = boundaryRequests.get(key);
    let conservationBoundary = boundaryRequest && (boundaryRequest.fromBlock !== fromBlock || boundaryRequest.toBlock !== scanTo)
      ? { status: "unavailable" as const, reason: "incomplete-log-range" as const }
      : conservationBoundaries.get(key);
    const pendingBoundaryBudget = { count: 0, limit: Math.max(0, configBudgetLimit - minimumScanRequests) };
    let result: Awaited<ReturnType<typeof syncMintBurnConfigWithRetries>>;
    try {
      if (boundaryReserve > 0) {
        const boundaries = await fetchConservationBoundaries({
          requests: [{ key, config, fromBlock, toBlock: scanTo }],
          rpcEndpointsByChain: new Map([[config.chain.chainId, chainContext.rpcEndpoints]]),
          budget: pendingBoundaryBudget,
          checkedAt: nowSec,
          signal: input.signal,
          deadlineMs: Math.min(deadlineMs, Date.now() + MINT_BURN_CONSERVATION_PREPASS_MAX_MS),
        });
        conservationBoundary = boundaries.get(key);
      }
      result = await syncMintBurnConfigWithRetries({
        db: input.db,
        config,
        key,
        tier,
        fromBlock,
        scanTo,
        chainHead: chainContext.chainHead,
        rpcEndpoints: chainContext.rpcEndpoints,
        endpointHeads: chainContext.endpointHeads,
        signal: input.signal,
        configBudgetLimit: configBudgetLimit - pendingBoundaryBudget.count,
        runTimestamp: input.runTimestamp,
        priceContext: input.priceContext,
        chainTimestampCache: chainContext.chainTimestampCache,
        txContextCache: chainContext.txContextCache,
        affectedHours,
        deadlineMs,
        conservationBoundary,
      });
    } catch (error) {
      rethrowIfAborted(error, input.signal);
      if (!pending) throw error;
      summary.errors = 1;
      summary.failedEventDefs = ["pending-scan-exception"];
      summary.advanceReason = "scan-coverage-unproven";
      summary.scanFrom = fromBlock;
      summary.scanTo = scanTo;
      summary.requestBudgetLimit = configBudgetLimit;
      summary.requestBudgetUsed = configBudgetLimit;
      input.budget.count += configBudgetLimit;
      logWorkerEventArgs("handler", "warn", `[sync-mint-burn] pending-scan-exception: ${key}`, error);
      finalizeSummary();
      continue;
    }
    Object.assign(summary, result.summary);
    summary.requestBudgetUsed += pendingBoundaryBudget.count;
    if (pending) summary.requestBudgetLimit = configBudgetLimit;

    rowsRead += summary.rowsRead;
    rowsParsed += summary.rowsParsed;
    rowsInserted += summary.rowsInserted;
    rowsIgnored += summary.rowsIgnored;
    rowsDropped += summary.rowsDropped;
    apiErrors += result.apiErrors;
    if (!pending) admittedApiErrors += result.apiErrors;
    effectiveBurns += result.effectiveBurns;
    bridgeBurns += result.bridgeBurns;
    reviewBurns += result.reviewBurns;
    atomicRoundtripsTotal += result.atomicRoundtripsDetected;
    txContextShortfalls += summary.txContextShortfalls;
    bridgeClassificationDeferredRows += summary.bridgeClassificationDeferredRows;

    if (result.newLastBlock != null && result.scanCoverage?.toBlock === result.newLastBlock) {
      input.pendingCursorUpdates.set(key, result.newLastBlock);
      input.pendingScanCoverage?.set(key, result.scanCoverage);
    } else if (result.newLastBlock != null) {
      summary.advancedTo = null;
      summary.advanceReason = "scan-coverage-unproven";
    }
    input.budget.count += summary.requestBudgetUsed;

    logWorkerEventArgs("handler", "info",
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
        logWorkerEventArgs("handler", "warn",
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
    admittedApiErrors,
    effectiveBurns,
    bridgeBurns,
    reviewBurns,
    atomicRoundtripsTotal,
    txContextShortfalls,
    bridgeClassificationDeferredRows,
    criticalContractsSatisfied,
    criticalContractsUnsatisfied,
    configBreakdown,
    activeProviderDeferrals,
    runtimeBudgetHit,
  };
}
