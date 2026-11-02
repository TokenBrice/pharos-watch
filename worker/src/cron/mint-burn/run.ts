import { logWorkerEvent, logWorkerEventArgs } from "../../lib/structured-log";
import { invalidateMintBurnFlowCaches, readMintBurnWindowContext } from "../../lib/mint-burn-flows-service";
import {
  isGrandfatheredMintBurnConfig,
  mintBurnDisabledReason,
  readMintBurnDisabledKeys,
  resolveMintBurnDisabledSymbolPolicy,
  syncMintBurnPublicationPolicy,
} from "../../lib/mint-burn-publication";
import { createBudget } from "../../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { loadMintBurnPriceContextBatch } from "../../lib/mint-burn-pipeline/context";
import type { MintBurnAffectedHour, MintBurnLane, SyncMintBurnStatus } from "../../lib/mint-burn-pipeline/types";
import { ensureMintBurnSyncStateRows, mintBurnConfigKey, readMintBurnSyncStateBatch, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../../lib/d1-primitives";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { loadMintBurnChainContexts } from "./chain-context";
import { recalcMintBurnAffectedHours } from "./recalc";
import { pruneMintBurnRetention } from "./retention";
import { completeMintBurnRun } from "./run-completion";
import { mintBurnPublicationMetadata } from "./publication-metadata";
import { configKey, configTier, runMintBurnConfigPhase, type MintBurnRunConfigPhaseResult } from "./run-configs";
import {
  getMintBurnRunState,
  normalizeDisabledConfigIdSet,
  normalizeDisabledSymbolSet,
  persistMintBurnRunDrilldown,
  resolveMintBurnResumeConfigKey,
  resolveRotatedConfigs,
  updateMintBurnAttemptState,
} from "./run-state";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { getCircuitRecordForAdmission } from "../../lib/circuit-breaker";
import {
  COVERAGE_REPAIR_REQUEST_LIMIT, COVERAGE_REPAIR_WINDOW_MS,
  loadMintBurnCoverageGaps, repairMintBurnCoverage,
} from "./repair-coverage";

const MAX_SCAN_RANGE = 50_000;

const MINT_BURN_CRITICAL_JOB = "sync-mint-burn";
const MINT_BURN_EXTENDED_JOB = "sync-mint-burn-extended";
const GLOBAL_BUDGET_LIMIT = 200;
const CRITICAL_CONFIG_BUDGET_LIMIT = 60;
const CRITICAL_BRIDGE_CONFIG_BUDGET_LIMIT = 150;
const EXTENDED_CONFIG_BUDGET_LIMIT = 25;
const DEGRADE_CONSECUTIVE_THRESHOLD = 2;
const ERROR_CONSECUTIVE_THRESHOLD = 3;

export interface SyncMintBurnOptions {
  signal?: AbortSignal;
  disabledConfigIds?: Iterable<string>;
  disabledSymbols?: Iterable<string>;
  lane?: MintBurnLane;
  jobName?: string;
  onProgress?: CronProgressReporter;
  chainRpcs?: ReadonlyMap<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  trongridApiKey?: string | null;
}

function laneIncludesConfig(lane: MintBurnLane, config: MintBurnContractConfig): boolean {
  if (lane === "all") return true;
  return lane === configTier(config);
}

function resolveMintBurnJobName(lane: MintBurnLane, explicitJobName?: string): string {
  if (explicitJobName) return explicitJobName;
  return lane === "extended" ? MINT_BURN_EXTENDED_JOB : MINT_BURN_CRITICAL_JOB;
}

/** One invocation owns scan state, hourly materialization, cursor commits and completion. */
export class MintBurnRun {
  private lastBlocksAfterRun!: Map<string, number>;
  private affectedHours!: Map<string, MintBurnAffectedHour>;
  private pendingCursorUpdates!: Map<string, number>;
  private pendingScanCoverage!: Map<string, MintBurnScanCoverage>;

  constructor(
    private readonly db: D1Database,
    private readonly alchemyApiKey: string | null,
    private readonly options: SyncMintBurnOptions = {},
  ) {}

  async execute(): Promise<{ itemCount: number; metadata: string; status?: SyncMintBurnStatus; error?: string }> {
    const { db, alchemyApiKey, options } = this;
    const signal = options.signal;
    const lane = options.lane ?? "all";
    const jobName = resolveMintBurnJobName(lane, options.jobName);
    const reportProgress = options.onProgress;
    const runTimestamp = Math.floor(Date.now() / 1000);
    const deadlineMs = Date.now() + 9 * 60_000;

    throwIfAborted(signal);
    const budget = createBudget(GLOBAL_BUDGET_LIMIT);
    const allActiveConfigs = includeActiveTrackedIds(MINT_BURN_CONFIGS, (config) => config.stablecoinId);
    const disabledConfigIds = normalizeDisabledConfigIdSet(options.disabledConfigIds);
    const operatorSymbols = normalizeDisabledSymbolSet(options.disabledSymbols);
    const priorDisabledKeys = operatorSymbols.size > 0
      ? await readMintBurnDisabledKeys(db)
      : new Set<string>();
    const symbolPolicy = resolveMintBurnDisabledSymbolPolicy(allActiveConfigs, operatorSymbols, priorDisabledKeys);
    const disabledSymbols = symbolPolicy.symbols;
    for (const ignored of symbolPolicy.ignored) {
      logWorkerEvent({
        scope: "handler",
        job: jobName,
        level: "warn",
        event: "mint_burn_disabled_symbol_ignored",
        message: "MINT_BURN_DISABLED_SYMBOLS entry names no single stablecoin; use MINT_BURN_DISABLED_IDS",
        metadata: {
          symbol: ignored.symbol,
          reason: ignored.reason,
          stablecoinIds: ignored.stablecoinIds,
          retainedConfigKeys: ignored.retainedKeys,
        },
      });
    }

    const allTrackableConfigs = allActiveConfigs.filter((config) => laneIncludesConfig(lane, config));
    let enabledConfigs: MintBurnContractConfig[] = [];
    const retentionConfigs: MintBurnContractConfig[] = [];
    const disabledConfigReasons = new Map<string, string>();
    const disabledPublicationKeys = new Set(symbolPolicy.retainedKeys);

    for (const config of allActiveConfigs) {
      const key = configKey(config);
      const reason = mintBurnDisabledReason(config, disabledConfigIds, disabledSymbols);
      if (reason || symbolPolicy.retainedKeys.has(key)) {
        disabledPublicationKeys.add(key);
        if (laneIncludesConfig(lane, config)) {
          disabledConfigReasons.set(key, reason ?? "symbol-disabled-retained");
        }
        continue;
      }

      retentionConfigs.push(config);
      if (laneIncludesConfig(lane, config)) enabledConfigs.push(config);
    }

    const configsDisabled = disabledConfigReasons.size;
    const contractsTotal = allTrackableConfigs.length;
    await syncMintBurnPublicationPolicy(db, disabledPublicationKeys, runTimestamp, allActiveConfigs.map(configKey));
    const publicationContext = await readMintBurnWindowContext(db, runTimestamp, allActiveConfigs);
    // Also the retention-protection set: a leg the scan treats as pending — including
    // a previously admitted one pending reactivation — can hold a mid-hour cursor and
    // still owe the rest of that hour's raw siblings. Never-admitted disabled legs
    // retain the earlier protection as well.
    const pendingAdmissionKeys = new Set(publicationContext.publication.legs
      .filter((leg) => leg.status === "pending-admission").map((leg) => leg.configKey));
    const grandfatheredKeys = new Set(allActiveConfigs.filter(isGrandfatheredMintBurnConfig).map(configKey));
    const pendingRetentionKeys = new Set(publicationContext.publication.legs
      .filter((leg) => leg.status === "pending-admission"
        || (leg.admittedAt == null && !grandfatheredKeys.has(leg.configKey)))
      .map((leg) => leg.configKey));
    const unsupportedKeys = new Set(publicationContext.publication.legs
      .filter((leg) => leg.reason === "unsupported-shared-bucket").map((leg) => leg.configKey));
    enabledConfigs = enabledConfigs.filter((config) => !unsupportedKeys.has(configKey(config)));

    if (enabledConfigs.length === 0) {
      const retention = lane === "critical"
        ? await pruneMintBurnRetention(db, runTimestamp, signal, { enabledConfigs: retentionConfigs, pendingAdmissionKeys: pendingRetentionKeys })
        : null;
      const metadata = JSON.stringify({
        publication: mintBurnPublicationMetadata(publicationContext.publication),
        outputPublishedAt: null,
        ...(retention?.error ? { reason: "mint-burn-retention-failed" } : {}),
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
        ...(retention ? { retention } : {}),
      });

      return {
        itemCount: 0,
        metadata,
        status: retention?.error ? "degraded" : "ok",
      };
    }

    if (!alchemyApiKey && enabledConfigs.some((config) => config.chain.chainId !== "tron")) {
      throw new Error("No ALCHEMY_API_KEY configured");
    }
    const apiKey = alchemyApiKey ?? "";

    const runStateSnapshot = await getMintBurnRunState(db, jobName);
    const runState = runStateSnapshot.state;
    const rotatedConfigs = resolveRotatedConfigs(
      runState.resumeConfigKey,
      enabledConfigs,
      (c) => mintBurnConfigKey(c),
    );
    // Always process critical contracts first so extended backlogs cannot starve
    // core coverage when budget pressure is high.
    const priorityConfigs = [
      ...rotatedConfigs.filter((config) => configTier(config) === "critical"),
      ...rotatedConfigs.filter((config) => configTier(config) === "extended"),
    ];
    const configs = [
      ...priorityConfigs.filter((config) => !pendingAdmissionKeys.has(configKey(config))),
      ...priorityConfigs.filter((config) => pendingAdmissionKeys.has(configKey(config))),
    ];

    await ensureMintBurnSyncStateRows(db, configs);
    const lastBlocks = await readMintBurnSyncStateBatch(db, configs);
    const lastBlocksAfterRun = this.lastBlocksAfterRun = new Map(lastBlocks);

    const tronCircuit = configs.some((config) => config.chain.chainId === "tron")
      ? await getCircuitRecordForAdmission(db, CIRCUIT_SOURCE.TRONGRID)
      : null;
    const tronOptions = {
      dwellirNative: options.dwellirNative,
      trongridApiKey: options.trongridApiKey,
      // Native outcomes are diagnostic-only; do not acquire another job's half-open probe.
      trongridAllowed: tronCircuit?.record.state === "closed",
      deadlineMs,
    };
    const chainContexts = await loadMintBurnChainContexts({
      configs: configs.filter((config) => !pendingAdmissionKeys.has(configKey(config))),
      apiKey,
      budget,
      signal,
      chainRpcs: options.chainRpcs,
      ...tronOptions,
    });
    const stablecoinIds = [...new Set(configs.map((config) => config.stablecoinId))];
    const priceContext = await loadMintBurnPriceContextBatch(
      db,
      stablecoinIds,
      D1_SAFE_IN_CLAUSE_BIND_LIMIT,
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

    const criticalContractsEnabled = enabledConfigs.filter((config) => configTier(config) === "critical"
      && !pendingAdmissionKeys.has(configKey(config))).length;
    const affectedHours = this.affectedHours = new Map<string, MintBurnAffectedHour>();
    const pendingCursorUpdates = this.pendingCursorUpdates = new Map<string, number>();
    const pendingScanCoverage = this.pendingScanCoverage = new Map<string, MintBurnScanCoverage>();

    const { phaseResult, recalcFailed, recalcError, pendingMaterializationFailures } = await this.scanAndMaterialize({
      db,
      configs,
      lane,
      jobName,
      reportProgress,
      budget,
      chainContexts,
      preparePendingConfigs: async (pendingBudget, pendingDeadlineMs) => {
        const pendingContexts = await loadMintBurnChainContexts({
          configs: configs.filter((config) => pendingAdmissionKeys.has(configKey(config))
            && !chainContexts.has(config.chain.chainId)),
          apiKey, budget: pendingBudget, signal, chainRpcs: options.chainRpcs,
          ...tronOptions,
          deadlineMs: pendingDeadlineMs,
        });
        for (const [chainId, context] of pendingContexts) {
          chainContexts.set(chainId, context);
        }
      },
      signal,
      runTimestamp,
      priceContext,
      lastBlocksAfterRun,
      pendingCursorUpdates,
      pendingScanCoverage,
      pendingAdmissionKeys,
      maxScanRange: MAX_SCAN_RANGE,
      criticalConfigBudgetLimit: CRITICAL_CONFIG_BUDGET_LIMIT,
      criticalBridgeConfigBudgetLimit: CRITICAL_BRIDGE_CONFIG_BUDGET_LIMIT,
      extendedConfigBudgetLimit: EXTENDED_CONFIG_BUDGET_LIMIT,
      affectedHours,
      deadlineMs,
    });

    const chainHeads = new Map(
      [...chainContexts.entries()].flatMap(([chainId, context]) =>
        context.chainHead == null ? [] : [[chainId, context.chainHead] as const]),
    );
    for (const summary of [...phaseResult.configBreakdown, ...(phaseResult.coverageRepairs ?? [])]) {
      if (summary.headFailureReason) chainHeads.delete(summary.chainId);
    }

    const attemptState = await updateMintBurnAttemptState({
      db,
      jobName,
      lane,
      enabledConfigKeys: enabledConfigs.filter((config) => !pendingAdmissionKeys.has(configKey(config)))
        .map((config) => mintBurnConfigKey(config)),
      configBreakdown: phaseResult.configBreakdown,
      activeProviderDeferrals: phaseResult.activeProviderDeferrals,
      nowSec: runTimestamp,
    });
    const runDrilldown = await persistMintBurnRunDrilldown({
      db,
      jobName,
      observedAt: runTimestamp,
      configBreakdown: phaseResult.configBreakdown as unknown as ReadonlyArray<Record<string, unknown>>,
    });
    const resumeConfigKey = resolveMintBurnResumeConfigKey(phaseResult.configBreakdown);

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
      criticalContractsEnabled,
      pendingAdmissionKeys,
      phase: phaseResult,
      attemptCoverage: attemptState.summary,
      coverageCycle: attemptState.coverageCycle,
      runDrilldown,
      signal,
    });

    let status = completion.status;
    // Surface recalcAffectedHours failure in metadata and downgrade critical-lane
    // runs so operators get a signal that hourly aggregates are stale.
    if (recalcFailed && lane !== "extended" && status === "ok") {
      status = "degraded";
      completion.metadata.reason = "mint-burn-hourly-recalc-failed";
    }
    completion.metadata.recalcFailed = recalcFailed;
    // Hourly materialization did not commit, so the in-memory scan advance is
    // not published flow evidence. Withhold the confirmed-output clock instead
    // of renewing it and let the existing producer-staleness alert escalate.
    if (recalcFailed && lane !== "extended") completion.metadata.outputPublishedAt = null;
    completion.metadata.pendingMaterialization = {
      failedCount: pendingMaterializationFailures.length,
      failures: pendingMaterializationFailures.slice(0, 12),
      failuresTruncated: pendingMaterializationFailures.length > 12,
    };
    completion.metadata.publication = mintBurnPublicationMetadata(
      (await readMintBurnWindowContext(db, runTimestamp, allActiveConfigs)).publication,
    );
    completion.metadata.coverageRepairs = phaseResult.coverageRepairs ?? [];
    const tronReader = chainContexts.get("tron")?.tronReader;
    if (tronReader) {
      completion.metadata.tronRpc = { calls: tronReader.calls, failures: tronReader.failures,
        conservationReason: phaseResult.configBreakdown.find((summary) => summary.chainId === "tron")?.conservationReason ?? null,
        circuitState: tronCircuit?.record.state ?? null,
        circuitInvalid: tronCircuit?.invalid ?? false };
    }
    if (recalcError) completion.metadata.recalcError = recalcError;
    if (lane === "critical") {
      const retention = await pruneMintBurnRetention(db, runTimestamp, signal, {
        enabledConfigs: retentionConfigs, pendingAdmissionKeys: pendingRetentionKeys,
      });
      completion.metadata.retention = retention;
      if (retention.error && status === "ok") {
        status = "degraded";
        completion.metadata.reason = "mint-burn-retention-failed";
      }
    }
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
        contractsProcessed: phaseResult.contractsProcessed,
        contractsSkipped: phaseResult.contractsSkipped,
      },
    }, budget);

    logWorkerEventArgs("handler", "info", `[sync-mint-burn] Completed with ${budget.count}/${budget.limit} subrequests (${status})`);

    if (status === "ok" || status === "degraded") {
      try {
        // Only the critical lane's scheduled sidecar republishes the aggregate
        // (Bank Run Gauge) cache rows after this purge; the extended lane has
        // no such sidecar and must leave the publication in place so the gauge
        // stays available between critical-lane runs.
        await invalidateMintBurnFlowCaches(db, { includeAggregate: lane !== "extended" });
      } catch (e) {
        logWorkerEventArgs("handler", "warn", "[sync-mint-burn] cache invalidation failed:", e);
      }
    }

    return {
      itemCount: phaseResult.rowsInserted,
      metadata,
      status,
      ...(completion.error !== null ? { error: completion.error } : {}),
    };
  }

  private async scanAndMaterialize(input: Parameters<typeof runMintBurnConfigPhase>[0]): Promise<{
    phaseResult: MintBurnRunConfigPhaseResult;
    recalcFailed: boolean;
    recalcError: string | null;
    pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }>;
  }> {
    let phaseResult!: MintBurnRunConfigPhaseResult;
    let recalcFailed = false;
    let recalcError: string | null = null;
    const pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }> = [];
    const repairProofs: MintBurnScanCoverage[] = [];
    const deadlineMs = input.deadlineMs ?? Date.now() + 9 * 60_000;
    try {
      const gaps = await loadMintBurnCoverageGaps(this.db, input.configs, input.lastBlocksAfterRun, input.runTimestamp);
      const liveBudget = {
        count: input.budget.count,
        limit: gaps.length ? Math.max(input.budget.count, input.budget.limit - COVERAGE_REPAIR_REQUEST_LIMIT) : input.budget.limit,
      };
      try {
        phaseResult = await runMintBurnConfigPhase({
          ...input, budget: liveBudget,
          deadlineMs: gaps.length ? deadlineMs - COVERAGE_REPAIR_WINDOW_MS : deadlineMs,
        });
      } finally {
        input.budget.count = liveBudget.count;
      }
      phaseResult.coverageRepairs = await repairMintBurnCoverage(
        { ...input, deadlineMs }, gaps, repairProofs, phaseResult.activeProviderDeferrals,
      );
      for (const repair of phaseResult.coverageRepairs) {
        phaseResult.rowsRead += repair.rowsRead;
        phaseResult.rowsParsed += repair.rowsParsed;
        phaseResult.rowsInserted += repair.rowsInserted;
        phaseResult.rowsIgnored += repair.rowsIgnored;
        phaseResult.rowsDropped += repair.rowsDropped;
      }
    } finally {
      const pendingBuckets = new Map<string, Set<string>>();
      const admittedBuckets = new Set(input.configs
        .filter((config) => !input.pendingAdmissionKeys?.has(configKey(config)))
        .map((config) => `${config.stablecoinId}:${config.chain.chainId}`));
      for (const config of input.configs) {
        const key = configKey(config);
        if (!input.pendingAdmissionKeys?.has(key)) continue;
        const bucket = `${config.stablecoinId}:${config.chain.chainId}`;
        // Legacy siblings share one hourly row. Mixed scope must keep that row
        // behind the admitted fence until storage can attribute each contract.
        if (admittedBuckets.has(bucket)) continue;
        const keys = pendingBuckets.get(bucket) ?? new Set<string>();
        keys.add(key);
        pendingBuckets.set(bucket, keys);
      }
      const admittedHours = new Map<string, MintBurnAffectedHour>();
      const pendingHours = new Map<string, Map<string, MintBurnAffectedHour>>();
      for (const [key, hour] of this.affectedHours) {
        const bucket = `${hour.stablecoinId}:${hour.chainId}`;
        if (!pendingBuckets.has(bucket)) {
          admittedHours.set(key, hour);
          continue;
        }
        const hours = pendingHours.get(bucket) ?? new Map<string, MintBurnAffectedHour>();
        hours.set(key, hour);
        pendingHours.set(bucket, hours);
      }
      const commitProofs = async (includesKey: (key: string) => boolean) => {
        for (const [key, nextLastBlock] of this.pendingCursorUpdates) {
          if (!includesKey(key)) continue;
          throwIfAborted(input.signal);
          const proof = this.pendingScanCoverage.get(key);
          if (proof?.toBlock !== nextLastBlock) continue;
          await upsertMintBurnSyncState(this.db, key, nextLastBlock, "monotonic-max", proof);
          this.lastBlocksAfterRun.set(key, nextLastBlock);
        }
        for (const proof of repairProofs) {
          if (!includesKey(proof.configKey)) continue;
          throwIfAborted(input.signal);
          await upsertMintBurnSyncState(this.db, proof.configKey, proof.toBlock, "monotonic-max", proof);
          this.lastBlocksAfterRun.set(proof.configKey,
            Math.max(this.lastBlocksAfterRun.get(proof.configKey) ?? 0, proof.toBlock));
          const repair = phaseResult?.coverageRepairs?.find((summary) =>
            summary.key === proof.configKey && summary.scanFrom === proof.fromBlock);
          if (repair) repair.repairReason = "proof-committed";
        }
      };
      const holdRepairProofs = (includesKey: (key: string) => boolean) => {
        for (const repair of phaseResult?.coverageRepairs ?? []) {
          if (includesKey(repair.key) && repair.repairReason === "proof-staged") repair.repairReason = "materialization-failed";
        }
      };
      const isolatedPendingKeys = new Set([...pendingBuckets.values()].flatMap((keys) => [...keys]));
      const isAdmitted = (key: string) => !isolatedPendingKeys.has(key);
      const recalcResult = await recalcMintBurnAffectedHours(this.db, admittedHours, input.signal);
      recalcFailed = recalcResult.failed;
      recalcError = recalcResult.error;
      if (recalcFailed) holdRepairProofs(isAdmitted);
      else await commitProofs(isAdmitted);

      // Admitted commits are durable before any pending bucket can fail. A held
      // pending cursor replays its raw rows and existing materialization debt.
      for (const [bucket, keys] of pendingBuckets) {
        const includesKey = (key: string) => keys.has(key);
        const result = await recalcMintBurnAffectedHours(this.db, pendingHours.get(bucket) ?? new Map(), input.signal);
        if (result.failed) {
          holdRepairProofs(includesKey);
          for (const key of keys) pendingMaterializationFailures.push({
            key, reason: "pending-hourly-recalc-failed", error: result.error?.slice(0, 200) ?? null,
          });
          continue;
        }
        try {
          await commitProofs(includesKey);
        } catch (error) {
          rethrowIfAborted(error, input.signal);
          for (const key of keys) pendingMaterializationFailures.push({
            key, reason: "pending-cursor-commit-failed", error: toErrorMessage(error).slice(0, 200),
          });
        }
      }
    }
    return { phaseResult, recalcFailed, recalcError, pendingMaterializationFailures };
  }
}
