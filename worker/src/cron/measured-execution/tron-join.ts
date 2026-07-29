import {
  toTronMeasuredExecutionPublicProfile,
  validateTronMeasuredExecutionProfile,
  type TronMeasuredExecutionProfile,
  type TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import type { PoolEntry } from "../dex-liquidity/types";
import { loadLatestPublishedTronMeasuredQuoteEvidence, type LoadedTronMeasuredQuoteEvidence } from "./persistence";
import {
  createNativeMeasuredExecutionJoinDiagnostics,
  joinNativeMeasuredExecutionEvidence,
  type NativeMeasuredExecutionJoinAdapter,
  type NativeMeasuredExecutionJoinDiagnostics,
} from "./native-join";
import {
  getTronMeasuredExecutionAdapterByProfile,
  isTronMeasuredExecutionAdapterScoreEligible,
  type TronMeasuredExecutionAdapter,
} from "./tron-registry";

export type TronMeasuredExecutionJoinDiagnostics = NativeMeasuredExecutionJoinDiagnostics;

type TronMeasuredExecutionJoinQuote =
  LoadedTronMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never;

export async function loadTronMeasuredExecutionJoinEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedTronMeasuredQuoteEvidence | null> {
  try {
    return await loadLatestPublishedTronMeasuredQuoteEvidence(db, signal);
  } catch {
    return null;
  }
}

export function joinTronMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedTronMeasuredQuoteEvidence | null;
  nowSec: number;
  resolveAdapterPolicy?: (adapterProfileId: string) => TronMeasuredExecutionAdapter | null;
}): TronMeasuredExecutionJoinDiagnostics {
  const adapter: NativeMeasuredExecutionJoinAdapter<
    TronMeasuredExecutionTarget,
    TronMeasuredExecutionProfile,
    ReturnType<typeof toTronMeasuredExecutionPublicProfile>,
    TronMeasuredExecutionAdapter,
    TronMeasuredExecutionJoinQuote,
    LoadedTronMeasuredQuoteEvidence,
    TronMeasuredExecutionJoinDiagnostics
  > = {
    kind: "tron",
    getTarget: (pool) => pool.extra?.tronMeasuredExecutionTarget,
    createDiagnostics: createNativeMeasuredExecutionJoinDiagnostics,
    resolvePolicy: input.resolveAdapterPolicy ?? getTronMeasuredExecutionAdapterByProfile,
    policyMatchesProfile: (policy, profile) =>
      policy.protocol === profile.protocol && policy.poolType === profile.poolType,
    validateProfile: ({ profile, quote, evidence, target, nowSec }) =>
      validateTronMeasuredExecutionProfile({
        profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: evidence.targetGenerationId,
        expectedQuoteGenerationId: evidence.quoteGenerationId,
        nowSec,
      }),
    toPublicProfile: toTronMeasuredExecutionPublicProfile,
    setPublicProfile: (pool, profile) => {
      pool.extra!.tronMeasuredExecution = profile;
    },
    getActivationFailure: ({ policy }) =>
      isTronMeasuredExecutionAdapterScoreEligible(policy)
        ? null
        : { reason: "activation-pending", detail: "shadow-score-ineligible" },
  };
  return joinNativeMeasuredExecutionEvidence({ ...input, adapter });
}

export function releaseTronMeasuredExecutionProofFields(pools: readonly PoolEntry[]): void {
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.tronMeasuredExecutionTarget;
    delete pool.extra.tronMeasuredExecutionProfile;
    delete pool.extra.tronMeasuredExecutionDiagnostic;
  }
}

export function stripTronMeasuredExecutionInternalFields(pools: readonly PoolEntry[]): void {
  releaseTronMeasuredExecutionProofFields(pools);
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.tronMeasuredExecutionPhysicalPoolId;
    delete pool.extra.nativeMeasuredExecution;
    delete pool.extra.nativeMeasuredExecutionPhysicalPoolId;
  }
}
