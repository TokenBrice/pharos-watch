import type { DexExecutionCapabilityGate } from "@shared/types/market";
import {
  toTronMeasuredExecutionPublicProfile,
  validateTronMeasuredExecutionProfile,
} from "@shared/types/tron-measured-execution";
import type { PoolEntry } from "../dex-liquidity/types";
import { loadLatestPublishedTronMeasuredQuoteEvidence, type LoadedTronMeasuredQuoteEvidence } from "./persistence";
import {
  createNativeMeasuredExecutionJoinDiagnostics,
  mapNativeMeasuredExecutionValidationGate,
  promoteNativeMeasuredExecutionProfile,
  recordNativeMeasuredExecutionFailure,
  resetNativeMeasuredExecutionJoinFields,
  type NativeMeasuredExecutionJoinDiagnostics,
} from "./native-join";
import {
  getTronMeasuredExecutionAdapterByProfile,
  isTronMeasuredExecutionAdapterScoreEligible,
  type TronMeasuredExecutionAdapter,
} from "./tron-registry";

export type TronMeasuredExecutionJoinDiagnostics = NativeMeasuredExecutionJoinDiagnostics;

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
  const diagnostics = createNativeMeasuredExecutionJoinDiagnostics(input.evidence);
  for (const pools of input.poolsByStablecoin.values()) {
    for (const pool of pools) {
      const target = pool.extra?.tronMeasuredExecutionTarget;
      if (!target) continue;
      diagnostics.targetCount++;
      const extra = resetNativeMeasuredExecutionJoinFields(pool, "tron", target);
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        recordNativeMeasuredExecutionFailure({
          pool,
          kind: "tron",
          target,
          diagnostics,
          reason,
          detail,
        });
      };
      if (!input.evidence) {
        fail("quote-missing");
        continue;
      }
      const quote = input.evidence.byTargetId.get(target.targetId);
      if (!quote) {
        fail("quote-missing");
        continue;
      }
      if (quote.status !== "measured" || !quote.profile) {
        fail("quote-failed", quote.failureReason ?? undefined);
        continue;
      }
      const adapter = (input.resolveAdapterPolicy ?? getTronMeasuredExecutionAdapterByProfile)(
        quote.profile.adapterProfileId,
      );
      if (!adapter || adapter.protocol !== quote.profile.protocol || adapter.poolType !== quote.profile.poolType) {
        fail("invalid-observation", "adapter-registration-mismatch");
        continue;
      }
      const issues = validateTronMeasuredExecutionProfile({
        profile: quote.profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: input.evidence.targetGenerationId,
        expectedQuoteGenerationId: input.evidence.quoteGenerationId,
        nowSec: input.nowSec,
      });
      if (issues.length > 0) {
        fail(mapNativeMeasuredExecutionValidationGate(issues), issues.join(","));
        continue;
      }
      const publicProfile = toTronMeasuredExecutionPublicProfile(quote.profile);
      extra.tronMeasuredExecution = publicProfile;
      if (!isTronMeasuredExecutionAdapterScoreEligible(adapter)) {
        fail("activation-pending", "shadow-score-ineligible");
        diagnostics.measuredCount++;
        continue;
      }
      promoteNativeMeasuredExecutionProfile({
        pool,
        kind: "tron",
        target,
        publicProfile,
      });
      diagnostics.measuredCount++;
    }
  }
  return diagnostics;
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
