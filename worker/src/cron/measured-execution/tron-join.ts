import type { DexExecutionCapabilityGate } from "@shared/types/market";
import {
  toTronMeasuredExecutionPublicProfile,
  validateTronMeasuredExecutionProfile,
} from "@shared/types/tron-measured-execution";
import type { PoolEntry } from "../dex-liquidity/types";
import { loadLatestPublishedTronMeasuredQuoteEvidence, type LoadedTronMeasuredQuoteEvidence } from "./persistence";
import {
  getTronMeasuredExecutionAdapterByProfile,
  isTronMeasuredExecutionAdapterScoreEligible,
  type TronMeasuredExecutionAdapter,
} from "./tron-registry";

export interface TronMeasuredExecutionJoinDiagnostics {
  targetCount: number;
  measuredCount: number;
  gatedCount: number;
  failuresByReason: Record<string, number>;
  quoteGenerationId: string | null;
  targetGenerationId: string | null;
}

function gate(reason: DexExecutionCapabilityGate["reason"]): DexExecutionCapabilityGate {
  return { family: "measured-execution", reason };
}

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

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

function mapValidationGate(issues: readonly string[]): DexExecutionCapabilityGate["reason"] {
  if (issues.includes("stale-observation")) return "stale-observation";
  if (issues.some((issue) => issue.includes("generation-mismatch"))) return "generation-mismatch";
  return "invalid-observation";
}

export function joinTronMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedTronMeasuredQuoteEvidence | null;
  nowSec: number;
  resolveAdapterPolicy?: (adapterProfileId: string) => TronMeasuredExecutionAdapter | null;
}): TronMeasuredExecutionJoinDiagnostics {
  const diagnostics: TronMeasuredExecutionJoinDiagnostics = {
    targetCount: 0,
    measuredCount: 0,
    gatedCount: 0,
    failuresByReason: {},
    quoteGenerationId: input.evidence?.quoteGenerationId ?? null,
    targetGenerationId: input.evidence?.targetGenerationId ?? null,
  };
  for (const pools of input.poolsByStablecoin.values()) {
    for (const pool of pools) {
      const target = pool.extra?.tronMeasuredExecutionTarget;
      if (!target) continue;
      diagnostics.targetCount++;
      pool.extra = { ...(pool.extra ?? {}) };
      delete pool.extra.tronMeasuredExecution;
      delete pool.extra.tronMeasuredExecutionProfile;
      pool.extra.tronMeasuredExecutionPhysicalPoolId = target.poolId;
      delete pool.extra.nativeMeasuredExecution;
      delete pool.extra.nativeMeasuredExecutionPhysicalPoolId;
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        pool.extra!.executionCapabilityGate = gate(reason);
        pool.extra!.tronMeasuredExecutionDiagnostic = {
          adapterProfileId: target.adapterProfileId,
          targetId: target.targetId,
          ...(detail ? { detail: detail.slice(0, 300) } : {}),
        };
        diagnostics.gatedCount++;
        increment(diagnostics.failuresByReason, `${target.adapterProfileId}:${reason}`);
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
        fail(mapValidationGate(issues), issues.join(","));
        continue;
      }
      const publicProfile = toTronMeasuredExecutionPublicProfile(quote.profile);
      pool.extra.tronMeasuredExecutionProfile = quote.profile;
      pool.extra.tronMeasuredExecution = publicProfile;
      if (!isTronMeasuredExecutionAdapterScoreEligible(adapter)) {
        fail("activation-pending", "shadow-score-ineligible");
        diagnostics.measuredCount++;
        continue;
      }
      pool.extra.nativeMeasuredExecution = publicProfile;
      pool.extra.nativeMeasuredExecutionPhysicalPoolId = target.poolId;
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.tronMeasuredExecutionDiagnostic = {
        adapterProfileId: target.adapterProfileId,
        targetId: target.targetId,
      };
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
