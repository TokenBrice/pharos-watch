import { logWorkerEventArgs } from "../../lib/structured-log";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config";
import type { EvaluatedYieldSource } from "./evaluation";
import {
  buildNextDeterministicOnChainHealthState,
  persistDeterministicOnChainHealthState,
} from "./state-loading";

type DeterministicOnChainHealthState = Parameters<
  typeof buildNextDeterministicOnChainHealthState
>[0]["previous"];

export function logYieldApyDivergences(evaluatedSources: EvaluatedYieldSource[]): void {
  const nativeApyByCoin = new Map<string, number>();
  const lendingApyByCoin = new Map<string, number>();

  for (const source of evaluatedSources) {
    if (source.yieldType === "lending-opportunity" || source.yieldType === "fixed-yield") {
      lendingApyByCoin.set(source.id, source.currentApy);
    } else {
      nativeApyByCoin.set(source.id, source.currentApy);
    }
  }

  for (const [coinId, nativeApy] of nativeApyByCoin) {
    const lendingApy = lendingApyByCoin.get(coinId);
    if (lendingApy == null || nativeApy <= 0 || lendingApy <= 0) continue;

    const divergence = Math.abs(nativeApy - lendingApy) / Math.max(Math.abs(nativeApy), Math.abs(lendingApy), 1e-9);
    if (divergence <= 0.35) continue;

    logWorkerEventArgs("handler", "warn",
      `[yield-sync] APY divergence for ${coinId}: native=${nativeApy.toFixed(1)}% vs lending=${lendingApy.toFixed(1)}%`,
    );
  }
}

export async function computeDeterministicOnChainHealth(params: {
  db: D1Database;
  startSec: number;
  evaluatedSources: EvaluatedYieldSource[];
  onChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownActive: boolean;
  onChainSkippedDueToCooldown: boolean;
  onChainAttemptedCount: number;
  onChainRatesResolved: number;
  allDeterministicFailed: boolean;
}): Promise<{
  maskedAllDeterministicFailure: boolean;
  onChainAlternativeCoverageMissingIds: string[];
  nextOnChainHealthState: DeterministicOnChainHealthState;
  onChainCooldownTriggered: boolean;
}> {
  const deterministicSourceIds = Array.from(
    new Set(ON_CHAIN_RATE_CONFIGS.map((config) => config.stablecoinId)),
  );
  const nonOnchainEvaluatedIds = new Set(
    params.evaluatedSources
      .filter((source) => source.dataSource !== "onchain")
      .map((source) => source.id),
  );
  const onChainAlternativeCoverageMissingIds = deterministicSourceIds.filter(
    (id) => !nonOnchainEvaluatedIds.has(id),
  );
  const maskedAllDeterministicFailure =
    params.allDeterministicFailed &&
    deterministicSourceIds.length > 0 &&
    onChainAlternativeCoverageMissingIds.length === 0;
  const nextOnChainHealthState = buildNextDeterministicOnChainHealthState({
    deterministicConfigCount: deterministicSourceIds.length,
    previous: params.onChainHealthState,
    startSec: params.startSec,
    onChainAttemptedCount: params.onChainAttemptedCount,
    onChainRatesResolved: params.onChainRatesResolved,
    allDeterministicFailed: params.allDeterministicFailed,
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    onChainSkippedDueToCooldown: params.onChainSkippedDueToCooldown,
  });
  const onChainCooldownTriggered =
    !params.onChainCooldownActive &&
    nextOnChainHealthState.cooldownUntil != null &&
    nextOnChainHealthState.cooldownUntil > params.startSec;

  await persistDeterministicOnChainHealthState(params.db, params.startSec, nextOnChainHealthState);

  if (params.allDeterministicFailed && maskedAllDeterministicFailure) {
    logWorkerEventArgs("handler", "warn",
      "[sync-yield-data] Deterministic on-chain lane failed, but all configured coins retained non-onchain yield coverage",
    );
  }

  return {
    maskedAllDeterministicFailure,
    onChainAlternativeCoverageMissingIds,
    nextOnChainHealthState,
    onChainCooldownTriggered,
  };
}
