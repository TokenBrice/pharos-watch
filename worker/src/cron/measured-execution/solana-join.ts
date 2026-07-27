import {
  toSolanaMeasuredExecutionPublicProfile,
  validateSolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionProfile,
} from "@shared/types/solana-measured-execution";
import type { DexExecutionCapabilityGate } from "@shared/types/market";
import type { PoolEntry } from "../dex-liquidity/types";
import { loadLatestPublishedSolanaMeasuredQuoteEvidence, type LoadedSolanaMeasuredQuoteEvidence } from "./persistence";
import {
  getSolanaMeasuredExecutionAdapterByProfile,
  getSolanaMeasuredExecutionPriorityTarget,
  isSolanaMeasuredExecutionPriorityTargetScoreEligible,
  type SolanaMeasuredExecutionAdapterRegistration,
} from "./solana-registry";
import { quoteRaydiumClmmSingleSegment } from "./solana-clmm-math";
import { RAYDIUM_CLMM_PROGRAM_ID } from "./solana-quotes";

export interface SolanaMeasuredExecutionJoinDiagnostics {
  targetCount: number;
  measuredCount: number;
  gatedCount: number;
  failuresByReason: Record<string, number>;
  lastKnownGoodCount: number;
  quoteGenerationId: string | null;
  targetGenerationId: string | null;
}

function hasRequiredRaydiumOnStateProof(
  profile: SolanaMeasuredExecutionProfile,
): boolean {
  if (profile.adapterProfileId !== "raydium-clmm-trade-api-v1") return false;
  return profile.quoteProof.every((point) => {
    const route = point.route;
    if (
      route.provider !== "raydium-trade-api" ||
      !route.stateProof ||
      !route.feeAmount ||
      route.stateProof.programId !== RAYDIUM_CLMM_PROGRAM_ID
    ) {
      return false;
    }
    try {
      const replay = quoteRaydiumClmmSingleSegment({
        liquidity: route.stateProof.liquidity,
        sqrtPriceX64: route.stateProof.sqrtPriceX64,
        amountIn: route.inputAmount,
        feeAmount: route.stateProof.feeAmount,
        direction: route.stateProof.direction,
      });
      return (
        route.feeAmount === route.stateProof.feeAmount &&
        replay.amountOut === route.outputAmount &&
        replay.postSwapSqrtPriceX64 === route.lastPoolPriceX64
      );
    } catch {
      return false;
    }
  });
}

function gate(reason: DexExecutionCapabilityGate["reason"]): DexExecutionCapabilityGate {
  return { family: "measured-execution", reason };
}

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

export async function loadSolanaMeasuredExecutionJoinEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedSolanaMeasuredQuoteEvidence | null> {
  try {
    return await loadLatestPublishedSolanaMeasuredQuoteEvidence(db, signal);
  } catch {
    return null;
  }
}

function mapValidationGate(issues: readonly string[]): DexExecutionCapabilityGate["reason"] {
  if (issues.includes("stale-observation")) return "stale-observation";
  if (issues.some((issue) => issue.includes("generation-mismatch"))) return "generation-mismatch";
  return "invalid-observation";
}

export function joinSolanaMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedSolanaMeasuredQuoteEvidence | null;
  nowSec: number;
  resolveAdapterPolicy?: (adapterProfileId: string) => SolanaMeasuredExecutionAdapterRegistration | null;
}): SolanaMeasuredExecutionJoinDiagnostics {
  const diagnostics: SolanaMeasuredExecutionJoinDiagnostics = {
    targetCount: 0,
    measuredCount: 0,
    gatedCount: 0,
    failuresByReason: {},
    lastKnownGoodCount: 0,
    quoteGenerationId: input.evidence?.quoteGenerationId ?? null,
    targetGenerationId: input.evidence?.targetGenerationId ?? null,
  };
  for (const pools of input.poolsByStablecoin.values()) {
    for (const pool of pools) {
      const target = pool.extra?.solanaMeasuredExecutionTarget;
      if (!target) continue;
      diagnostics.targetCount++;
      pool.extra = { ...(pool.extra ?? {}) };
      delete pool.extra.solanaMeasuredExecution;
      delete pool.extra.solanaMeasuredExecutionProfile;
      pool.extra.solanaMeasuredExecutionPhysicalPoolId = target.poolId;
      delete pool.extra.nativeMeasuredExecution;
      delete pool.extra.nativeMeasuredExecutionPhysicalPoolId;
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        pool.extra!.executionCapabilityGate = gate(reason);
        pool.extra!.solanaMeasuredExecutionDiagnostic = {
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
      const adapter = (input.resolveAdapterPolicy ?? getSolanaMeasuredExecutionAdapterByProfile)(
        quote.profile.adapterProfileId,
      );
      if (!adapter || adapter.protocol !== quote.profile.protocol || adapter.poolType !== quote.profile.poolType) {
        fail("invalid-observation", "adapter-registration-mismatch");
        continue;
      }
      const issues = validateSolanaMeasuredExecutionProfile({
        profile: quote.profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec: input.nowSec,
      });
      if (issues.length > 0) {
        fail(mapValidationGate(issues), issues.join(","));
        continue;
      }
      const publicProfile = toSolanaMeasuredExecutionPublicProfile(quote.profile);
      pool.extra.solanaMeasuredExecution = publicProfile;
      const policy = getSolanaMeasuredExecutionPriorityTarget(target);
      if (!isSolanaMeasuredExecutionPriorityTargetScoreEligible(target)) {
        fail("activation-pending", policy ? "shadow-score-ineligible" : "unratified-target");
        diagnostics.measuredCount++;
        continue;
      }
      if (policy?.proofRequirement === "raydium-single-segment-onstate-v1" && !hasRequiredRaydiumOnStateProof(quote.profile)) {
        fail("invalid-observation", "raydium-onstate-proof-invalid");
        continue;
      }
      pool.extra.nativeMeasuredExecution = publicProfile;
      pool.extra.nativeMeasuredExecutionPhysicalPoolId = target.poolId;
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.solanaMeasuredExecutionDiagnostic = {
        adapterProfileId: target.adapterProfileId,
        targetId: target.targetId,
        ...(quote.resolution === "last-known-good"
          ? { detail: `last-known-good-after:${quote.latestFailureReason ?? "quote-missing"}` }
          : {}),
      };
      if (quote.resolution === "last-known-good") diagnostics.lastKnownGoodCount++;
      diagnostics.measuredCount++;
    }
  }
  return diagnostics;
}

export function releaseSolanaMeasuredExecutionProofFields(pools: readonly PoolEntry[]): void {
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.solanaMeasuredExecutionTarget;
    delete pool.extra.solanaMeasuredExecutionProfile;
    delete pool.extra.solanaMeasuredExecutionDiagnostic;
  }
}

export function stripSolanaMeasuredExecutionInternalFields(pools: readonly PoolEntry[]): void {
  releaseSolanaMeasuredExecutionProofFields(pools);
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.solanaMeasuredExecutionPhysicalPoolId;
    delete pool.extra.nativeMeasuredExecution;
    delete pool.extra.nativeMeasuredExecutionPhysicalPoolId;
  }
}
