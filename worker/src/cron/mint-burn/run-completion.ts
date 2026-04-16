import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import { getNullPriceBacklog, healNullPrices } from "../../lib/mint-burn-pipeline/price-heal";
import { sweepRecentRoundtrips } from "../../lib/mint-burn-pipeline/roundtrip-sweep";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnAffectedHour } from "../../lib/mint-burn-pipeline/types";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { withBudgetMetadata } from "../../lib/cron-progress";
import { setMintBurnRunState, type MintBurnRunStateRow } from "./run-state";
import type { MintBurnConfigSummary } from "./sync-config";
import type { SyncMintBurnStatus, MintBurnLane } from "../sync-mint-burn";

export async function completeMintBurnRun(input: {
  db: D1Database;
  budget: { limit: number; count: number };
  lane: MintBurnLane;
  jobName: string;
  chainHeads: Map<string, number>;
  startIndex: number;
  enabledConfigs: MintBurnContractConfig[];
  configs: MintBurnContractConfig[];
  configsDisabled: number;
  contractsTotal: number;
  lastBlocksAfterRun: Map<string, number>;
  runState: MintBurnRunStateRow;
  runStatePersistenceFailed: boolean;
  degradeConsecutiveThreshold: number;
  errorConsecutiveThreshold: number;
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
  criticalContractsEnabled: number;
  criticalContractsSatisfied: number;
  criticalContractsUnsatisfied: number;
  configBreakdown: MintBurnConfigSummary[];
}): Promise<{ status: SyncMintBurnStatus; metadata: string }> {
  const laggingConfigs = input.configs
    .map((config) => {
      const key = mintBurnConfigKey(config);
      const last = input.lastBlocksAfterRun.get(key) ?? (config.startBlock - 1);
      const head = input.chainHeads.get(config.chain.chainId) ?? null;
      return {
        key,
        symbol: config.symbol,
        chainId: config.chain.chainId,
        lagBlocks: head != null ? Math.max(0, head - last) : null,
        head,
        lastBlock: last,
      };
    })
    .sort((a, b) => (b.lagBlocks ?? -1) - (a.lagBlocks ?? -1))
    .slice(0, 6);

  const coverageRatio = input.enabledConfigs.length > 0 ? input.contractsProcessed / input.enabledConfigs.length : 1;
  const criticalCoverageRatio =
    input.criticalContractsEnabled > 0 ? input.criticalContractsSatisfied / input.criticalContractsEnabled : 1;
  const degradedSignal =
    input.lane === "extended"
      ? input.apiErrors > 1
      : criticalCoverageRatio < 1 || input.apiErrors > 1;
  const degradedStreak = degradedSignal ? input.runState.degradedStreak + 1 : 0;

  let status: SyncMintBurnStatus = "ok";
  if (input.lane !== "extended" && degradedStreak >= input.errorConsecutiveThreshold) {
    status = "error";
  } else if (degradedStreak >= input.degradeConsecutiveThreshold) {
    status = "degraded";
  }

  const nextConfigIndex = input.enabledConfigs.length > 0
    ? (input.startIndex + 1) % input.enabledConfigs.length
    : 0;
  // Track the config AT startIndex — stable across additions/removals
  const lastConfigKey = input.enabledConfigs.length > 0
    ? mintBurnConfigKey(input.enabledConfigs[input.startIndex % input.enabledConfigs.length])
    : null;
  const runStatePersisted = await setMintBurnRunState(
    input.db, input.jobName, nextConfigIndex, degradedStreak, lastConfigKey,
  );
  const runStatePersistenceFailed = input.runStatePersistenceFailed || !runStatePersisted;
  if (runStatePersistenceFailed && status === "ok") {
    status = "degraded";
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let nullPricesHealed = 0;
  const nullPriceBacklog = await getNullPriceBacklog(input.db, nowSec);
  if (status !== "error") {
    try {
      const healResult = await healNullPrices(input.db, nowSec);
      nullPricesHealed = healResult.healed;
      if (healResult.affectedHours.size > 0) {
        await recalcAffectedHours(input.db, healResult.affectedHours as Map<string, MintBurnAffectedHour>);
      }
    } catch (error) {
      console.warn("[sync-mint-burn] Price heal failed (non-fatal):", error);
    }
  }

  let roundtripSweepCount = 0;
  if (status !== "error") {
    try {
      const sweepResult = await sweepRecentRoundtrips(input.db, nowSec);
      roundtripSweepCount = sweepResult.reclassified;
      if (roundtripSweepCount > 0) {
        console.log(`[sync-mint-burn] Roundtrip sweep reclassified ${roundtripSweepCount} rows`);
      }
    } catch (error) {
      console.warn("[sync-mint-burn] Roundtrip sweep failed (non-fatal):", error);
    }
  }

  const compatibilityChainHead = input.chainHeads.get("ethereum")
    ?? Math.max(0, ...input.chainHeads.values());

  const metadata = JSON.stringify(withBudgetMetadata(input.budget, {
    lane: input.lane,
    jobName: input.jobName,
    chainHead: compatibilityChainHead || null,
    chainHeads: Object.fromEntries(input.chainHeads),
    rowsRead: input.rowsRead,
    rowsParsed: input.rowsParsed,
    rowsInserted: input.rowsInserted,
    rowsIgnored: input.rowsIgnored,
    rowsDropped: input.rowsDropped,
    sourceCoverage: {
      contractsProcessed: input.contractsProcessed,
      contractsSkipped: input.contractsSkipped,
      contractsEnabled: input.enabledConfigs.length,
      contractsDisabled: input.configsDisabled,
      contractsTotal: input.contractsTotal,
    },
    configsDisabled: input.configsDisabled,
    contractsProcessed: input.contractsProcessed,
    contractsSkipped: input.contractsSkipped,
    contractsDeferredExtended: input.contractsDeferredExtended,
    apiErrors: input.apiErrors,
    validationFailures: input.apiErrors,
    fallbackMode: null,
    burnClassification: {
      effectiveBurns: input.effectiveBurns,
      bridgeBurns: input.bridgeBurns,
      reviewBurns: input.reviewBurns,
    },
    atomicRoundtripsDetected: input.atomicRoundtripsTotal,
    criticalCoverage: {
      contractsEnabled: input.criticalContractsEnabled,
      contractsSatisfied: input.criticalContractsSatisfied,
      contractsUnsatisfied: input.criticalContractsUnsatisfied,
      ratio: criticalCoverageRatio,
    },
    configBreakdown: input.configBreakdown,
    laggingConfigs,
    coverageRatio,
    degradedSignal,
    degradedStreak,
    runStatePersistenceFailed,
    nullPricesHealed,
    nullPriceBacklog,
    roundtripSweepCount,
  }));

  return { status, metadata };
}
