import {
  toSolanaMeasuredExecutionPublicProfile,
  validateSolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionProfile,
  type SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import type { PoolEntry } from "../dex-liquidity/types";
import { loadLatestPublishedSolanaMeasuredQuoteEvidence, type LoadedSolanaMeasuredQuoteEvidence } from "./persistence";
import {
  createNativeMeasuredExecutionJoinDiagnostics,
  joinNativeMeasuredExecutionEvidence,
  type NativeMeasuredExecutionJoinAdapter,
  type NativeMeasuredExecutionJoinDiagnostics,
} from "./native-join";
import {
  getSolanaMeasuredExecutionAdapterByProfile,
  getSolanaMeasuredExecutionPriorityTarget,
  isSolanaMeasuredExecutionPriorityTargetScoreEligible,
  type SolanaMeasuredExecutionAdapterRegistration,
} from "./solana-registry";
import { quoteRaydiumClmmSingleSegment } from "./solana-clmm-math";
import { RAYDIUM_CLMM_PROGRAM_ID } from "./solana-quotes";

export interface SolanaMeasuredExecutionJoinDiagnostics extends NativeMeasuredExecutionJoinDiagnostics {
  lastKnownGoodCount: number;
}

type SolanaMeasuredExecutionJoinQuote =
  LoadedSolanaMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T> ? T : never;

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

export function joinSolanaMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedSolanaMeasuredQuoteEvidence | null;
  nowSec: number;
  resolveAdapterPolicy?: (adapterProfileId: string) => SolanaMeasuredExecutionAdapterRegistration | null;
}): SolanaMeasuredExecutionJoinDiagnostics {
  const adapter: NativeMeasuredExecutionJoinAdapter<
    SolanaMeasuredExecutionTarget,
    SolanaMeasuredExecutionProfile,
    ReturnType<typeof toSolanaMeasuredExecutionPublicProfile>,
    SolanaMeasuredExecutionAdapterRegistration,
    SolanaMeasuredExecutionJoinQuote,
    LoadedSolanaMeasuredQuoteEvidence,
    SolanaMeasuredExecutionJoinDiagnostics
  > = {
    kind: "solana",
    getTarget: (pool) => pool.extra?.solanaMeasuredExecutionTarget,
    createDiagnostics: (evidence) => ({
      ...createNativeMeasuredExecutionJoinDiagnostics(evidence),
      lastKnownGoodCount: 0,
    }),
    resolvePolicy: input.resolveAdapterPolicy ?? getSolanaMeasuredExecutionAdapterByProfile,
    policyMatchesProfile: (policy, profile) =>
      policy.protocol === profile.protocol && policy.poolType === profile.poolType,
    validateProfile: ({ profile, quote, target, nowSec }) =>
      validateSolanaMeasuredExecutionProfile({
        profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec,
      }),
    toPublicProfile: toSolanaMeasuredExecutionPublicProfile,
    setPublicProfile: (pool, profile) => {
      pool.extra!.solanaMeasuredExecution = profile;
    },
    getActivationFailure: ({ target }) => {
      const policy = getSolanaMeasuredExecutionPriorityTarget(target);
      return isSolanaMeasuredExecutionPriorityTargetScoreEligible(target)
        ? null
        : {
            reason: "activation-pending",
            detail: policy ? "shadow-score-ineligible" : "unratified-target",
          };
    },
    getProofFailure: ({ profile, target }) => {
      const policy = getSolanaMeasuredExecutionPriorityTarget(target);
      return policy?.proofRequirement === "raydium-single-segment-onstate-v1" &&
        !hasRequiredRaydiumOnStateProof(profile)
        ? { reason: "invalid-observation", detail: "raydium-onstate-proof-invalid" }
        : null;
    },
    getPromotionDetail: (quote) =>
      quote.resolution === "last-known-good"
        ? `last-known-good-after:${quote.latestFailureReason ?? "quote-missing"}`
        : undefined,
    onPromoted: (diagnostics, quote) => {
      if (quote.resolution === "last-known-good") diagnostics.lastKnownGoodCount++;
    },
  };
  return joinNativeMeasuredExecutionEvidence({ ...input, adapter });
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
