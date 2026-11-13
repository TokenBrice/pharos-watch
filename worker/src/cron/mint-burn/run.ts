import { logWorkerEvent, logWorkerEventArgs } from "../../lib/structured-log";
import { invalidateMintBurnFlowCaches, readMintBurnWindowContext } from "../../lib/mint-burn-flows-service";
import {
  isGrandfatheredMintBurnConfig,
  MintBurnPublicationPolicyDecodeError,
  mintBurnDisabledReason,
  readMintBurnDisabledKeys,
  resolveMintBurnDisabledSymbolPolicy,
  syncMintBurnPublicationPolicy,
} from "../../lib/mint-burn-publication";
import { createBudget } from "../../lib/evm-logs";
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { loadMintBurnPriceContextBatch } from "../../lib/mint-burn-pipeline/context";
import type { MintBurnAffectedHour, MintBurnLane, SyncMintBurnStatus } from "../../lib/mint-burn-pipeline/types";
import { mintBurnConfigKey } from "../../lib/mint-burn-contract-identity";
import { ensureMintBurnSyncStateRows, readMintBurnSyncStateBatch } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../../lib/d1-primitives";
import type { CronProgressReporter } from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { loadMintBurnChainContexts } from "./chain-context";
import { publishMintBurnScan } from "./recalc";
import { pruneMintBurnRetention } from "./retention";
import { runMintBurnSupplyReconciliation } from "../../lib/mint-burn-supply-reconciliation";
import { completeMintBurnRun } from "./run-completion";
import { mintBurnPublicationMetadata } from "./publication-metadata";
import { mintBurnConfigKey as configKey } from "../../lib/mint-burn-contract-identity";
import { configTier, runMintBurnConfigPhase, type MintBurnRunConfigPhaseResult } from "./run-configs";
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
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { getCircuitRecordForAdmission } from "../../lib/circuit-breaker";
import {
  idleMintBurnRepairD1, loadMintBurnCoverageGaps, repairMintBurnCoverage,
} from "./repair-coverage";
import { loadMintBurnSupplyProofRepairRanges } from "./repair-supply-proofs";
import { mintBurnConservationFingerprint, requiresReviewedSupplyBurnProof } from "../../lib/mint-burn-conservation";
import { invalidateChangedMintBurnSupplyProofConfigs } from "../../lib/mint-burn-supply-proofs";
import { isD1ResourceWindowError } from "../../lib/d1-overload-retry";
import { createMintBurnConfigSummary } from "./sync-config";

const MAX_SCAN_RANGE = 50_000;

const MINT_BURN_CRITICAL_JOB = "sync-mint-burn";
const MINT_BURN_EXTENDED_JOB = "sync-mint-burn-extended";
const GLOBAL_BUDGET_LIMIT = 200;
const CRITICAL_CONFIG_BUDGET_LIMIT = 60;
const CRITICAL_BRIDGE_CONFIG_BUDGET_LIMIT = 150;
const EXTENDED_CONFIG_BUDGET_LIMIT = 25;
// One extended-tier coverage repair. Eight requests fund a one-page scan with supply boundaries and a cold
// head read for all but four of the 127 extended configs; four more fund transaction-context batches.
const EXTENDED_HOLE_REPAIR_RESERVE_REQUESTS = 12;
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
    const invalidatedSupplyProofs = await invalidateChangedMintBurnSupplyProofConfigs(db, new Map(MINT_BURN_CONFIGS.filter(requiresReviewedSupplyBurnProof).map((config) =>
      [mintBurnConfigKey(config), mintBurnConservationFingerprint(config)])), { signal });
    if (invalidatedSupplyProofs > 0) await invalidateMintBurnFlowCaches(db);
    const budget = createBudget(GLOBAL_BUDGET_LIMIT);
    const allActiveConfigs = includeActiveTrackedIds(MINT_BURN_CONFIGS, (config) => config.stablecoinId);
    const disabledConfigIds = normalizeDisabledConfigIdSet(options.disabledConfigIds);
    const operatorSymbols = normalizeDisabledSymbolSet(options.disabledSymbols);
    let priorDisabledKeys = new Set<string>();
    if (operatorSymbols.size > 0) {
      try {
        priorDisabledKeys = await readMintBurnDisabledKeys(db, signal);
      } catch (error) {
        // Only a stored value that cannot be decoded may proceed with no
        // retained keys, because the policy sync below rewrites that row from
        // the env switch. A failed read must fail the lane closed before any
        // rewrite: treating it as "nothing disabled" would erase the durable
        // quarantine the rollout is meant to preserve.
        if (!(error instanceof MintBurnPublicationPolicyDecodeError)) throw error;
        logWorkerEvent({
          scope: "handler",
          job: jobName,
          level: "warn",
          event: "mint_burn_disabled_policy_unreadable",
          message: "Stored mint/burn disabled policy is unreadable; retaining no durable keys and rewriting it from the env switch",
          error,
          metadata: { configuredSymbols: [...operatorSymbols].sort() },
        });
      }
    }
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
    const reactivationKeys = new Set(publicationContext.publication.legs
      .filter((leg) => leg.reason === "reactivation-pending").map((leg) => leg.configKey));
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
    const lastBlocksAfterRun = new Map(lastBlocks);

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
      configs: configs.filter((config) => !pendingAdmissionKeys.has(configKey(config)))
        .concat(lane === "critical" ? publicationContext.diagnosticConfigs : []),
      apiKey,
      budget,
      signal,
      chainRpcs: options.chainRpcs,
      ...tronOptions,
    });
    const stablecoinIds = [...new Set([...configs, ...(lane === "critical" ? publicationContext.diagnosticConfigs : [])]
      .map((config) => config.stablecoinId))];
    const priceContext = await loadMintBurnPriceContextBatch(
      db,
      stablecoinIds,
      D1_SAFE_IN_CLAUSE_BIND_LIMIT,
    );

    // Daily operator evidence shares the serialized producer and its 200-request cap.
    // Reserve this bounded slice before scans can consume the remaining budget.
    let dailyReconciliation: Awaited<ReturnType<typeof runMintBurnSupplyReconciliation>> | undefined;
    if (lane === "critical" || lane === "all") {
      try {
        dailyReconciliation = await runMintBurnSupplyReconciliation({
          db, configs: publicationContext.diagnosticConfigs, now: runTimestamp, budget, signal, deadlineMs,
          rpcEndpointsByChain: new Map([...chainContexts].map(([chainId, context]) => [chainId, context.rpcEndpoints])),
          heads: new Map([...chainContexts].flatMap(([chainId, context]) => context.chainHead == null ? [] : [[chainId, context.chainHead]])),
          priceContext,
        });
      } catch (error) {
        rethrowIfAborted(error, signal);
        dailyReconciliation = { processed: 0, requests: 0, reason: "daily-reconciliation-maintenance-failed" };
      }
    }

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
    const affectedHours = new Map<string, MintBurnAffectedHour>();
    const pendingCursorUpdates = new Map<string, number>();
    const pendingScanCoverage = new Map<string, MintBurnScanCoverage>();

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
      reactivationKeys,
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
    const resumeConfigKey = resolveMintBurnResumeConfigKey(phaseResult.configBreakdown, pendingAdmissionKeys);

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
      recalcFailed,
      signal,
    });

    let status = completion.status;
    completion.metadata.recalcFailed = recalcFailed;
    completion.metadata.pendingMaterialization = {
      failedCount: pendingMaterializationFailures.length,
      failures: pendingMaterializationFailures.slice(0, 12),
      failuresTruncated: pendingMaterializationFailures.length > 12,
    };
    completion.metadata.publication = mintBurnPublicationMetadata(
      (await readMintBurnWindowContext(db, runTimestamp, allActiveConfigs)).publication,
    );
    completion.metadata.coverageRepairs = phaseResult.coverageRepairs ?? [];
    if (dailyReconciliation) completion.metadata.dailyReconciliation = dailyReconciliation;
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

  private async scanAndMaterialize(input: Parameters<typeof runMintBurnConfigPhase>[0] & { pendingScanCoverage: Map<string, MintBurnScanCoverage> }): Promise<{
    phaseResult: MintBurnRunConfigPhaseResult;
    recalcFailed: boolean;
    recalcError: string | null;
    pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }>;
  }> {
    let phaseResult!: MintBurnRunConfigPhaseResult;
    let recalcFailed = false;
    let recalcError: string | null = null;
    let pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }> = [];
    const repairProofs: MintBurnScanCoverage[] = [];
    const supplyRepairRanges = new Map<string, { config: MintBurnContractConfig; toBlock: number }>();
    const deadlineMs = input.deadlineMs ?? Date.now() + 9 * 60_000;
    try {
      const discoveries = await Promise.allSettled([
        loadMintBurnCoverageGaps(this.db, input.configs, input.lastBlocksAfterRun, input.runTimestamp),
        loadMintBurnSupplyProofRepairRanges(this.db, input.configs, input.lastBlocksAfterRun, input.runTimestamp),
      ]);
      let discoveryFailed = false;
      for (const discovery of discoveries) {
        if (discovery.status !== "rejected") continue;
        rethrowIfAborted(discovery.reason, input.signal);
        if (!isD1ResourceWindowError(discovery.reason)) throw discovery.reason;
        discoveryFailed = true;
      }
      const gaps = discoveries[0].status === "fulfilled" ? discoveries[0].value : [];
      const supplyRanges = discoveries[1].status === "fulfilled" ? discoveries[1].value : [];
      if (discoveryFailed) await idleMintBurnRepairD1(deadlineMs, input.signal);
      for (const range of supplyRanges) {
        supplyRepairRanges.set(`${configKey(range.config)}:${range.fromBlock}`, range);
      }
      // One attempt per config: a window's coverage hole precedes its independent supply replay.
      const repairs = [...new Map([...supplyRanges, ...gaps].map((range) => [configKey(range.config), range])).values()];
      // Repairs consume leftovers; discovery never reduces live runtime. One exception: the extended live
      // scan spends its whole budget, so a known coverage hole of an admitted config holds one repair's
      // requests out of it. The repair pass gets them back and gives them to the first hole it attempts.
      const holeKeys = new Set(input.lane === "extended" && !discoveryFailed
        ? gaps.map((gap) => configKey(gap.config)).filter((key) => !input.pendingAdmissionKeys?.has(key)) : []);
      const repairReserve = holeKeys.size > 0 ? EXTENDED_HOLE_REPAIR_RESERVE_REQUESTS : 0;
      // Lower the limit, not the count: progress snapshots report the count as requests used.
      input.budget.limit -= repairReserve;
      try {
        phaseResult = await runMintBurnConfigPhase({ ...input, deadlineMs });
      } finally {
        input.budget.limit += repairReserve;
      }
      phaseResult.coverageRepairs = discoveryFailed ? input.configs.map((config) => ({
        ...createMintBurnConfigSummary(config, configKey(config), config.tier ?? "critical"),
        errors: 1, skippedReason: "repair-runtime-exhausted", repairReason: "repair-runtime-exhausted" as const,
      })) : await repairMintBurnCoverage(
        { ...input, deadlineMs }, repairs, repairProofs, phaseResult.activeProviderDeferrals,
        { supplyProofRepair: true, ...(repairReserve > 0 ? { leadKeys: holeKeys, leadAllowance: repairReserve } : {}) },
      );
      for (const repair of phaseResult.coverageRepairs) {
        phaseResult.rowsRead += repair.rowsRead;
        phaseResult.rowsParsed += repair.rowsParsed;
        phaseResult.rowsInserted += repair.rowsInserted;
        phaseResult.rowsIgnored += repair.rowsIgnored;
        phaseResult.rowsDropped += repair.rowsDropped;
      }
    } finally {
      ({ recalcFailed, recalcError, pendingMaterializationFailures } = await publishMintBurnScan(this.db, input, {
        repairProofs, supplyRepairRanges, coverageRepairs: phaseResult?.coverageRepairs, deadlineMs,
      }));
    }
    return { phaseResult, recalcFailed, recalcError, pendingMaterializationFailures };
  }
}
