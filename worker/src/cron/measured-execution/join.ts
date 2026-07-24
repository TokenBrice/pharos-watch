import {
  isDexMeasuredExecutionObservationHistoryMature,
  toDexMeasuredExecutionPublicProfile,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionProfile,
} from "@shared/types/measured-execution";
import type { DexExecutionCapabilityGate } from "@shared/types/market";
import type { PoolEntry } from "../dex-liquidity/types";
import {
  getFluidResolverDeployment,
  validateFluidResolverProfileProof,
  FLUID_RESOLVER_ADAPTER_PROFILE_ID,
} from "./fluid-resolver";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  getCurveCryptoSwapShadowPolicy,
  validateCurveCryptoSwapProfileProof,
} from "./curve-cryptoswap";
import { loadLatestPublishedDexMeasuredQuoteEvidence, type LoadedDexMeasuredQuoteEvidence } from "./persistence";
import { validateQuoterV2ProfileProof } from "./quoter-v2";
import { getDexMeasuredExecutionDeployment, isDexMeasuredExecutionDeploymentScoreEligible } from "./registry";
import { logWorkerEvent } from "../../lib/structured-log";

export interface DexMeasuredExecutionJoinDiagnostics {
  targetCount: number;
  measuredCount: number;
  lastKnownGoodCount: number;
  gatedCount: number;
  failuresByReason: Record<string, number>;
  quoteGenerationId: string | null;
  targetGenerationId: string | null;
}

export type DexMeasuredExecutionRetainedRoutePools = Map<string, PoolEntry[]>;

function gate(reason: DexExecutionCapabilityGate["reason"]): DexExecutionCapabilityGate {
  return { family: "measured-execution", reason };
}

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

export async function loadDexMeasuredExecutionJoinEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  try {
    return await loadLatestPublishedDexMeasuredQuoteEvidence(db, signal);
  } catch (error) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "quote_generation_load_failed",
      job: "sync-cl-exit-depth",
      message: "Failed to load measured-execution quote generation",
      error,
    });
    return null;
  }
}

function deploymentIssues(profile: DexMeasuredExecutionProfile): string[] {
  if (
    profile.adapterProfileId === "uniswap-v3-quoter-v2" ||
    profile.adapterProfileId === "pancakeswap-v3-quoter-v2" ||
    profile.adapterProfileId === "aerodrome-slipstream-quoter-v2"
  ) {
    const deployment = getDexMeasuredExecutionDeployment(profile.adapterProfileId, profile.chain);
    if (!deployment) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== deployment.endpointAddress) issues.push("endpoint-address-mismatch");
    if (profile.executionEndpoint.codeHash !== deployment.expectedCodeHash) issues.push("endpoint-code-hash-mismatch");
    issues.push(...validateQuoterV2ProfileProof(profile));
    return issues;
  }
  if (profile.adapterProfileId === FLUID_RESOLVER_ADAPTER_PROFILE_ID) {
    const deployment = getFluidResolverDeployment(profile.chain);
    if (!deployment) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== deployment.endpointAddress) issues.push("endpoint-address-mismatch");
    if (profile.executionEndpoint.codeHash !== deployment.expectedCodeHash) issues.push("endpoint-code-hash-mismatch");
    issues.push(...validateFluidResolverProfileProof(profile));
    return issues;
  }
  if (profile.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID) {
    const policy = getCurveCryptoSwapShadowPolicy(profile.chain, profile.executionEndpoint.address);
    if (!policy) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== policy.poolAddress) issues.push("endpoint-address-mismatch");
    if (profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash) issues.push("endpoint-code-hash-mismatch");
    issues.push(...validateCurveCryptoSwapProfileProof(profile));
    return issues;
  }
  return ["adapter-profile-unsupported"];
}

function mapValidationGate(issues: readonly string[]): DexExecutionCapabilityGate["reason"] {
  if (issues.includes("stale-observation")) return "stale-observation";
  if (issues.some((issue) => issue.includes("generation-mismatch"))) return "generation-mismatch";
  if (issues.some((issue) => issue.includes("endpoint-") || issue.includes("deployment-"))) {
    return "deployment-code-mismatch";
  }
  return "invalid-observation";
}

function currentMeasuredTargetIds(poolsByStablecoin: ReadonlyMap<string, readonly PoolEntry[]>): Set<string> {
  return new Set(
    [...poolsByStablecoin.values()].flatMap((pools) =>
      pools.flatMap((pool) => {
        const targetId = pool.extra?.measuredExecutionTarget?.targetId;
        return targetId ? [targetId] : [];
      }),
    ),
  );
}

function currentPhysicalPoolKeys(poolsByStablecoin: ReadonlyMap<string, readonly PoolEntry[]>): Set<string> {
  return new Set(
    [...poolsByStablecoin.entries()].flatMap(([stablecoinId, pools]) =>
      pools.map((pool) => `${stablecoinId}:${pool.chain.toLowerCase()}:${pool.poolId.toLowerCase()}`),
    ),
  );
}

/**
 * Retain mature measured routes across a bounded shortlist rotation.
 *
 * The quote ledger already validates and freshness-bounds last-known-good
 * profiles. This projection keeps those profiles available to the route
 * compiler when their physical pool falls out of the next display/liquidity
 * shortlist. The returned pools are route-only: callers must not merge them
 * into aggregate TVL, volume, or V8 liquidity scoring.
 */
export function buildDexMeasuredExecutionRetainedRoutePools(input: {
  poolsByStablecoin: ReadonlyMap<string, readonly PoolEntry[]>;
  evidence: LoadedDexMeasuredQuoteEvidence | null;
  nowSec: number;
}): DexMeasuredExecutionRetainedRoutePools {
  const retained = new Map<string, PoolEntry[]>();
  if (!input.evidence) return retained;

  const currentTargetIds = currentMeasuredTargetIds(input.poolsByStablecoin);
  const currentPoolKeys = currentPhysicalPoolKeys(input.poolsByStablecoin);
  const retainedPoolKeys = new Set<string>();
  const entries = [...input.evidence.byTargetId.entries()].sort(([left], [right]) => left.localeCompare(right));

  for (const [targetId, quote] of entries) {
    if (
      currentTargetIds.has(targetId) ||
      quote.resolution !== "last-known-good" ||
      quote.status !== "measured" ||
      quote.profile === null ||
      !isDexMeasuredExecutionObservationHistoryMature(quote.observationHistory)
    ) {
      continue;
    }
    const target = quote.quotedTarget;
    const profile = quote.profile;
    if (!input.poolsByStablecoin.has(target.stablecoinId)) continue;
    if (
      profile.adapterProfileId !== "uniswap-v3-quoter-v2" &&
      profile.adapterProfileId !== "pancakeswap-v3-quoter-v2" &&
      profile.adapterProfileId !== "aerodrome-slipstream-quoter-v2"
    ) {
      continue;
    }
    if (!isDexMeasuredExecutionDeploymentScoreEligible(profile.adapterProfileId, profile.chain)) continue;
    const issues = [
      ...validateDexMeasuredExecutionProfile({
        profile,
        quotedTarget: target,
        currentTarget: target,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec: input.nowSec,
      }),
      ...deploymentIssues(profile),
    ];
    if (issues.length > 0) continue;

    const physicalPoolKey =
      `${target.stablecoinId}:${profile.chain.toLowerCase()}:${profile.poolId.toLowerCase()}`;
    if (currentPoolKeys.has(physicalPoolKey) || retainedPoolKeys.has(physicalPoolKey)) continue;
    retainedPoolKeys.add(physicalPoolKey);
    const pools = retained.get(target.stablecoinId) ?? [];
    pools.push({
      poolId: profile.poolId,
      project: profile.protocol,
      chain: profile.chain,
      tvlUsd: profile.retainedTvlUsdAtQuote,
      symbol: `${profile.tokenIn.symbol}-${profile.tokenOut.symbol}`,
      volumeUsd1d: 0,
      poolType:
        profile.adapterProfileId === "pancakeswap-v3-quoter-v2"
          ? "pancakeswap-v3-measured-retained"
          : profile.adapterProfileId === "aerodrome-slipstream-quoter-v2"
            ? "aerodrome-slipstream-measured-retained"
            : "uniswap-v3-measured-retained",
      source: profile.adapterProfileId === "uniswap-v3-quoter-v2" ? "dl" : "direct_api",
      price: profile.tokenIn.referencePriceUsd,
      extra: {
        measuredExecutionTarget: target,
        measuredExecution: toDexMeasuredExecutionPublicProfile(profile, {
          observationHistory: quote.observationHistory,
        }),
        measuredExecutionProfile: profile,
        measuredExecutionPhysicalPoolId: profile.poolId,
        measuredExecutionDiagnostic: {
          adapterProfileId: target.adapterProfileId,
          targetId,
          detail: `route-retained-after:${quote.latestFailureReason ?? "shortlist-rotation"}`,
        },
      },
    });
    retained.set(target.stablecoinId, pools);
  }

  return retained;
}

export function joinDexMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedDexMeasuredQuoteEvidence | null;
  nowSec: number;
}): DexMeasuredExecutionJoinDiagnostics {
  const diagnostics: DexMeasuredExecutionJoinDiagnostics = {
    targetCount: 0,
    measuredCount: 0,
    lastKnownGoodCount: 0,
    gatedCount: 0,
    failuresByReason: {},
    quoteGenerationId: input.evidence?.quoteGenerationId ?? null,
    targetGenerationId: input.evidence?.targetGenerationId ?? null,
  };
  for (const pools of input.poolsByStablecoin.values()) {
    for (const pool of pools) {
      const target = pool.extra?.measuredExecutionTarget;
      if (!target) continue;
      diagnostics.targetCount++;
      pool.extra = { ...(pool.extra ?? {}) };
      delete pool.extra.measuredExecution;
      delete pool.extra.measuredExecutionProfile;
      pool.extra.measuredExecutionPhysicalPoolId = target.poolId;
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        pool.extra!.executionCapabilityGate = gate(reason);
        pool.extra!.measuredExecutionDiagnostic = {
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
      pool.extra.measuredExecutionProfile = quote.profile;
      const genericIssues = validateDexMeasuredExecutionProfile({
        profile: quote.profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec: input.nowSec,
      });
      const adapterIssues = deploymentIssues(quote.profile);
      const issues = [...genericIssues, ...adapterIssues];
      if (issues.length > 0) {
        delete pool.extra.measuredExecutionProfile;
        fail(mapValidationGate(issues), issues.join(","));
        continue;
      }
      pool.extra.measuredExecution = toDexMeasuredExecutionPublicProfile(quote.profile, {
        ...(quote.observationHistory ? { observationHistory: quote.observationHistory } : {}),
      });
      const lastKnownGoodDetail =
        quote.resolution === "last-known-good"
          ? `last-known-good-after:${quote.latestFailureReason ?? "quote-missing"}`
          : undefined;
      const curvePolicy =
        quote.profile.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID
          ? getCurveCryptoSwapShadowPolicy(quote.profile.chain, quote.profile.executionEndpoint.address)
          : null;
      const activationPending =
        quote.profile.adapterProfileId === FLUID_RESOLVER_ADAPTER_PROFILE_ID ||
        (quote.profile.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID
          ? !curvePolicy?.scoreEligible
          : !isDexMeasuredExecutionDeploymentScoreEligible(quote.profile.adapterProfileId, quote.profile.chain));
      if (activationPending) {
        pool.extra.executionCapabilityGate = gate("activation-pending");
        pool.extra.measuredExecutionDiagnostic = {
          adapterProfileId: target.adapterProfileId,
          targetId: target.targetId,
          detail: ["shadow-score-ineligible", lastKnownGoodDetail].filter(Boolean).join(","),
        };
        diagnostics.measuredCount++;
        if (quote.resolution === "last-known-good") diagnostics.lastKnownGoodCount++;
        diagnostics.gatedCount++;
        increment(diagnostics.failuresByReason, `${target.adapterProfileId}:activation-pending`);
        continue;
      }
      if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
        delete pool.extra.executionCapabilityGate;
      }
      pool.extra.measuredExecutionDiagnostic = {
        adapterProfileId: target.adapterProfileId,
        targetId: target.targetId,
        ...(lastKnownGoodDetail ? { detail: lastKnownGoodDetail } : {}),
      };
      diagnostics.measuredCount++;
      if (quote.resolution === "last-known-good") diagnostics.lastKnownGoodCount++;
    }
  }
  return diagnostics;
}

export function stripDexMeasuredExecutionInternalFields(pools: readonly PoolEntry[]): void {
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.measuredExecutionTarget;
    delete pool.extra.measuredExecutionProfile;
    delete pool.extra.measuredExecutionPhysicalPoolId;
    delete pool.extra.measuredExecutionDiagnostic;
  }
}
