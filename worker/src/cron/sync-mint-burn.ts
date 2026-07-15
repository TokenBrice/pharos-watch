import { invalidateMintBurnFlowCaches } from "../api/mint-burn-flows-shared";
import {
  createBudget,
} from "../lib/evm-logs";
import {
  MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT,
  MINT_BURN_CONFIGS,
  type MintBurnContractConfig,
} from "../lib/mint-burn-contracts";
import { loadMintBurnPriceContextBatch } from "../lib/mint-burn-pipeline/context";
import type { MintBurnAffectedHour, MintBurnLane, SyncMintBurnStatus } from "../lib/mint-burn-pipeline/types";
import {
  ensureMintBurnSyncStateRows,
  mintBurnConfigKey,
  readMintBurnSyncStateBatch,
} from "../lib/mint-burn-pipeline/sync-state";
import type { CronProgressReporter } from "../lib/cron-logger";
import { reportCronProgress } from "../lib/cron-progress";
import { loadMintBurnChainContexts } from "./mint-burn/chain-context";
import { recalcMintBurnAffectedHours } from "./mint-burn/recalc";
import { completeMintBurnRun } from "./mint-burn/run-completion";
import { configKey, configTier, runMintBurnConfigPhase, type MintBurnRunConfigPhaseResult } from "./mint-burn/run-configs";
import {
  getMintBurnRunState,
  normalizeDisabledConfigIdSet,
  normalizeDisabledSymbolSet,
  persistMintBurnRunDrilldown,
  resolveMintBurnResumeConfigKey,
  resolveRotatedConfigs,
  updateMintBurnAttemptState,
} from "./mint-burn/run-state";
import { includeActiveTrackedIds } from "./shared/exclude-frozen";
import { throwIfAborted } from "../lib/abort";

const MAX_SCAN_RANGE = 50_000;
const EVM_SAFETY_MARGIN_BLOCKS = 75; // Math.ceil(900s indexing safety / 12s block time)

const MINT_BURN_CRITICAL_JOB = "sync-mint-burn";
const MINT_BURN_EXTENDED_JOB = "sync-mint-burn-extended";
const GLOBAL_BUDGET_LIMIT = 200;
const CRITICAL_CONFIG_BUDGET_LIMIT = 60;
const CRITICAL_BRIDGE_CONFIG_BUDGET_LIMIT = 150;
const EXTENDED_CONFIG_BUDGET_LIMIT = 25;
const DEGRADE_CONSECUTIVE_THRESHOLD = 2;
const ERROR_CONSECUTIVE_THRESHOLD = 3;
const SQL_IN_CHUNK_SIZE = 90;

export type { SyncMintBurnStatus, MintBurnLane } from "../lib/mint-burn-pipeline/types";

export interface SyncMintBurnOptions {
  signal?: AbortSignal;
  disabledConfigIds?: Iterable<string>;
  disabledSymbols?: Iterable<string>;
  lane?: MintBurnLane;
  jobName?: string;
  onProgress?: CronProgressReporter;
}

function laneIncludesConfig(lane: MintBurnLane, config: MintBurnContractConfig): boolean {
  if (lane === "all") return true;
  return lane === configTier(config);
}

function resolveMintBurnJobName(lane: MintBurnLane, explicitJobName?: string): string {
  if (explicitJobName) return explicitJobName;
  return lane === "extended" ? MINT_BURN_EXTENDED_JOB : MINT_BURN_CRITICAL_JOB;
}

export async function syncMintBurn(
  db: D1Database,
  alchemyApiKey: string | null,
  options: SyncMintBurnOptions = {},
): Promise<{ itemCount: number; metadata: string; status?: SyncMintBurnStatus; error?: string }> {
  const signal = options.signal;
  const lane = options.lane ?? "all";
  const jobName = resolveMintBurnJobName(lane, options.jobName);
  const reportProgress = options.onProgress;

  throwIfAborted(signal);
  const budget = createBudget(GLOBAL_BUDGET_LIMIT);
  const disabledConfigIds = normalizeDisabledConfigIdSet(options.disabledConfigIds);
  const disabledSymbols = normalizeDisabledSymbolSet(options.disabledSymbols);

  const allTrackableConfigs = includeActiveTrackedIds(
    MINT_BURN_CONFIGS.filter((config) => laneIncludesConfig(lane, config)),
    (config) => config.stablecoinId,
  );
  const enabledConfigs: MintBurnContractConfig[] = [];
  const disabledConfigReasons = new Map<string, string>();

  for (const config of allTrackableConfigs) {
    const key = configKey(config);
    const symbol = config.symbol.toUpperCase();
    const isDisabledByConfig = config.enabled === false;
    const isDisabledBySymbol = disabledSymbols.has(symbol);
    const isDisabledById =
      disabledConfigIds.has(config.stablecoinId.toLowerCase()) ||
      disabledConfigIds.has(key.toLowerCase());

    if (isDisabledByConfig || isDisabledBySymbol || isDisabledById) {
      const reason =
        isDisabledByConfig ? "config-disabled" :
        isDisabledBySymbol ? "symbol-disabled" :
        "id-disabled";
      disabledConfigReasons.set(key, reason);
      continue;
    }

    enabledConfigs.push(config);
  }

  const configsDisabled = disabledConfigReasons.size;
  const contractsTotal = allTrackableConfigs.length;

  if (enabledConfigs.length === 0) {
    const metadata = JSON.stringify({
      lane,
      jobName,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
      rowsRead: 0,
      rowsParsed: 0,
      rowsInserted: 0,
      rowsIgnored: 0,
      rowsDropped: 0,
      sourceCoverage: {
        contractsProcessed: 0,
        contractsSkipped: 0,
        contractsEnabled: 0,
        contractsDisabled: configsDisabled,
        contractsTotal,
      },
      configsDisabled,
      contractsProcessed: 0,
      contractsSkipped: 0,
      chainHeads: {},
      apiErrors: 0,
      fallbackMode: null,
      validationFailures: 0,
      bridgeValidationErrors: MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT,
      bridgeClassification: {
        txContextShortfalls: 0,
        deferredRows: 0,
      },
      configBreakdown: [],
      laggingConfigs: [],
      degradedSignal: false,
      degradedStreak: 0,
      coverageRatio: 1,
      nullPricesHealed: 0,
    });

    return {
      itemCount: 0,
      metadata,
      status: "ok",
    };
  }

  if (!alchemyApiKey) {
    throw new Error("No ALCHEMY_API_KEY configured");
  }
  const apiKey = alchemyApiKey;

  const runStateSnapshot = await getMintBurnRunState(db, jobName);
  const runState = runStateSnapshot.state;
  const rotatedConfigs = resolveRotatedConfigs(
    runState.resumeConfigKey,
    enabledConfigs,
    (c) => mintBurnConfigKey(c),
  );
  // Always process critical contracts first so extended backlogs cannot starve
  // core coverage when budget pressure is high.
  const configs = [
    ...rotatedConfigs.filter((config) => configTier(config) === "critical"),
    ...rotatedConfigs.filter((config) => configTier(config) === "extended"),
  ];

  await ensureMintBurnSyncStateRows(db, configs);
  const lastBlocks = await readMintBurnSyncStateBatch(db, configs);
  const lastBlocksAfterRun = new Map(lastBlocks);

  const chainContexts = await loadMintBurnChainContexts({
    configs,
    apiKey,
    budget,
    signal,
  });
  const chainHeads = new Map(
    [...chainContexts.entries()].map(([chainId, context]) => [chainId, context.chainHead]),
  );

  const stablecoinIds = [...new Set(configs.map((config) => config.stablecoinId))];
  const runTimestamp = Math.floor(Date.now() / 1000);
  const { prices, priceHistory } = await loadMintBurnPriceContextBatch(
    db,
    stablecoinIds,
    SQL_IN_CHUNK_SIZE,
  );

  await reportCronProgress(reportProgress, {
    stage: lane === "extended" ? "extended-queue" : lane === "critical" ? "critical-queue" : "queue",
    itemsDone: 0,
    itemsTotal: configs.length,
    message: `Preparing ${configs.length} config(s) for ${lane} mint/burn sync`,
    metadata: {
      lane,
      jobName,
      contractsEnabled: enabledConfigs.length,
      contractsTotal,
    },
  }, budget);

  const criticalContractsEnabled = enabledConfigs.filter((config) => configTier(config) === "critical").length;
  const affectedHours = new Map<string, MintBurnAffectedHour>();

  let phaseResult!: MintBurnRunConfigPhaseResult;
  let recalcFailed = false;
  let recalcError: string | null = null;
  try {
    phaseResult = await runMintBurnConfigPhase({
      db,
      configs,
      lane,
      jobName,
      reportProgress,
      budget,
      chainContexts,
      signal,
      runTimestamp,
      priceContext: { prices, priceHistory },
      lastBlocksAfterRun,
      maxScanRange: MAX_SCAN_RANGE,
      criticalConfigBudgetLimit: CRITICAL_CONFIG_BUDGET_LIMIT,
      criticalBridgeConfigBudgetLimit: CRITICAL_BRIDGE_CONFIG_BUDGET_LIMIT,
      extendedConfigBudgetLimit: EXTENDED_CONFIG_BUDGET_LIMIT,
      evmSafetyMarginBlocks: EVM_SAFETY_MARGIN_BLOCKS,
      affectedHours,
    });
  } finally {
    const recalcResult = await recalcMintBurnAffectedHours(db, affectedHours, signal);
    recalcFailed = recalcResult.failed;
    recalcError = recalcResult.error;
  }

  const {
    rowsRead, rowsParsed, rowsInserted, rowsIgnored, rowsDropped,
    contractsProcessed, contractsSkipped, contractsDeferredExtended,
    apiErrors, effectiveBurns, bridgeBurns, reviewBurns,
    atomicRoundtripsTotal, txContextShortfalls, bridgeClassificationDeferredRows,
    criticalContractsSatisfied, criticalContractsUnsatisfied,
    configBreakdown,
  } = phaseResult;
  const attemptCoverage = await updateMintBurnAttemptState({
    db,
    jobName,
    enabledConfigKeys: enabledConfigs.map((config) => mintBurnConfigKey(config)),
    configBreakdown,
    activeProviderDeferrals: phaseResult.activeProviderDeferrals,
    nowSec: runTimestamp,
  });
  const runDrilldown = await persistMintBurnRunDrilldown({
    db,
    jobName,
    observedAt: runTimestamp,
    configBreakdown: configBreakdown as unknown as ReadonlyArray<Record<string, unknown>>,
  });
  const resumeConfigKey = resolveMintBurnResumeConfigKey(configBreakdown);

  await reportCronProgress(reportProgress, {
    stage: "recalc-hours",
    itemsDone: configs.length,
    itemsTotal: configs.length,
    message: `Recalculating ${affectedHours.size} affected hourly bucket(s)`,
    metadata: {
      lane,
      jobName,
      affectedHours: affectedHours.size,
    },
  }, budget);

  const completion = await completeMintBurnRun({
    db,
    budget,
    lane,
    jobName,
    chainHeads,
    resumeConfigKey,
    enabledConfigs,
    configs,
    configsDisabled,
    contractsTotal,
    lastBlocksAfterRun,
    runState,
    runStatePersistenceFailed: runStateSnapshot.persistenceFailed,
    degradeConsecutiveThreshold: DEGRADE_CONSECUTIVE_THRESHOLD,
    errorConsecutiveThreshold: ERROR_CONSECUTIVE_THRESHOLD,
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
    criticalContractsEnabled,
    criticalContractsSatisfied,
    criticalContractsUnsatisfied,
    configBreakdown, runtimeBudgetHit: phaseResult.runtimeBudgetHit,
    attemptCoverage,
    runDrilldown,
    signal,
  });

  let status = completion.status;
  // Surface recalcAffectedHours failure in metadata and downgrade critical-lane
  // runs so operators get a signal that hourly aggregates are stale.
  if (recalcFailed && lane !== "extended" && status === "ok") {
    status = "degraded";
  }
  completion.metadata.recalcFailed = recalcFailed;
  completion.metadata.bridgeValidationErrors = MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT;
  if (recalcError) completion.metadata.recalcError = recalcError;
  const metadata = JSON.stringify(completion.metadata);

  await reportCronProgress(reportProgress, {
    stage: "complete",
    itemsDone: configs.length,
    itemsTotal: configs.length,
    message: `Completed ${lane} mint/burn sync`,
    metadata: {
      lane,
      jobName,
      status,
      contractsProcessed,
      contractsSkipped,
    },
  }, budget);

  console.log(`[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests (${status})`);

  if (status === "ok" || status === "degraded") {
    try {
      await invalidateMintBurnFlowCaches(db);
    } catch (e) {
      console.warn("[sync-mint-burn] cache invalidation failed:", e);
    }
  }

  return {
    itemCount: rowsInserted,
    metadata,
    status,
    ...(completion.error !== null ? { error: completion.error } : {}),
  };
}
