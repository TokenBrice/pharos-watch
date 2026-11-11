import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import type { MintBurnAffectedHour } from "../../lib/mint-burn-pipeline/types";
import { logWorkerEvent } from "../../lib/structured-log";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";

import { upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import type { MintBurnScanCoverage } from "../../lib/mint-burn-pipeline/scan-coverage";
import type { MintBurnContractConfig } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey as configKey } from "../../lib/mint-burn-contract-identity";
import { isD1ResourceWindowError } from "../../lib/d1-overload-retry";
import { idleMintBurnRepairD1 } from "./repair-coverage";
import { commitMintBurnSupplyProofRepair } from "./repair-supply-proofs";
import type { runMintBurnConfigPhase, MintBurnRunConfigPhaseResult } from "./run-configs";

async function recalcMintBurnAffectedHours(
  db: D1Database,
  affectedHours: Map<string, MintBurnAffectedHour>,
  signal?: AbortSignal,
): Promise<{ failed: boolean; error: string | null }> {
  if (affectedHours.size === 0) return { failed: false, error: null };

  try {
    await recalcAffectedHours(db, affectedHours, { signal });
    return { failed: false, error: null };
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "sync-mint-burn.recalc-affected-hours-failed",
      job: "sync-mint-burn",
      message: "recalcAffectedHours failed in finally block",
      error,
    });
    return { failed: true, error: toErrorMessage(error) };
  }
}

/** Materialize each publication scope before certifying its coverage and cursors. */
export async function publishMintBurnScan(
  db: D1Database,
  input: Parameters<typeof runMintBurnConfigPhase>[0] & { pendingScanCoverage: Map<string, MintBurnScanCoverage> },
  staged: {
    repairProofs: MintBurnScanCoverage[];
    supplyRepairRanges: Map<string, { config: MintBurnContractConfig; toBlock: number }>;
    coverageRepairs: MintBurnRunConfigPhaseResult["coverageRepairs"];
    deadlineMs: number;
  },
): Promise<{
  recalcFailed: boolean;
  recalcError: string | null;
  pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }>;
}> {
  const { repairProofs, supplyRepairRanges, coverageRepairs, deadlineMs } = staged;
  const pendingMaterializationFailures: Array<{ key: string; reason: string; error: string | null }> = [];
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
  for (const [key, hour] of input.affectedHours) {
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
    for (const [key, nextLastBlock] of input.pendingCursorUpdates) {
      if (!includesKey(key)) continue;
      throwIfAborted(input.signal);
      const proof = input.pendingScanCoverage.get(key);
      if (proof?.toBlock !== nextLastBlock) continue;
      await upsertMintBurnSyncState(db, key, nextLastBlock, "monotonic-max", proof);
      input.lastBlocksAfterRun.set(key, nextLastBlock);
    }
    for (const proof of repairProofs) {
      if (!includesKey(proof.configKey)) continue;
      throwIfAborted(input.signal);
      for (let attempt = 0; ; attempt++) {
        try {
          const supplyRange = supplyRepairRanges.get(`${proof.configKey}:${proof.fromBlock}`);
          if (supplyRange && proof.toBlock <= supplyRange.toBlock) {
            await commitMintBurnSupplyProofRepair(db, supplyRange.config, proof);
          } else {
            await upsertMintBurnSyncState(db, proof.configKey, proof.toBlock, "monotonic-max", proof);
            input.lastBlocksAfterRun.set(proof.configKey,
              Math.max(input.lastBlocksAfterRun.get(proof.configKey) ?? 0, proof.toBlock));
          }
          break;
        } catch (error) {
          rethrowIfAborted(error, input.signal);
          if (!isD1ResourceWindowError(error)) throw error;
          if (attempt === 0 && await idleMintBurnRepairD1(deadlineMs, input.signal)) continue;
          // Materialized rows remain durable. Hold only their uncommitted
          // proof/cursor; the next run can safely replay them.
          for (const repair of coverageRepairs ?? []) {
            if (includesKey(repair.key) && repair.repairReason === "proof-staged") {
              repair.errors++;
              repair.repairReason = "repair-runtime-exhausted";
            }
          }
          return;
        }
      }
      const repair = coverageRepairs?.find((summary) =>
        summary.key === proof.configKey && summary.scanFrom === proof.fromBlock);
      if (repair) repair.repairReason = "proof-committed";
    }
  };
  const holdRepairProofs = (includesKey: (key: string) => boolean) => {
    for (const repair of coverageRepairs ?? []) {
      if (includesKey(repair.key) && repair.repairReason === "proof-staged") repair.repairReason = "materialization-failed";
    }
  };
  const isolatedPendingKeys = new Set([...pendingBuckets.values()].flatMap((keys) => [...keys]));
  const isAdmitted = (key: string) => !isolatedPendingKeys.has(key);
  const recalcResult = await recalcMintBurnAffectedHours(db, admittedHours, input.signal);
  const recalcFailed = recalcResult.failed;
  const recalcError = recalcResult.error;
  if (recalcFailed) holdRepairProofs(isAdmitted);
  else await commitProofs(isAdmitted);

  // Admitted commits are durable before any pending bucket can fail. A held
  // pending cursor replays its raw rows and existing materialization debt.
  for (const [bucket, keys] of pendingBuckets) {
    const includesKey = (key: string) => keys.has(key);
    const result = await recalcMintBurnAffectedHours(db, pendingHours.get(bucket) ?? new Map(), input.signal);
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
  return { recalcFailed, recalcError, pendingMaterializationFailures };
}
