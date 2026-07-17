import {
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

export interface DexMeasuredExecutionJoinDiagnostics {
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

export async function loadDexMeasuredExecutionJoinEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  try {
    return await loadLatestPublishedDexMeasuredQuoteEvidence(db, signal);
  } catch (error) {
    console.warn("[measured-execution] Failed to load quote generation:", error);
    return null;
  }
}

function deploymentIssues(profile: DexMeasuredExecutionProfile): string[] {
  if (profile.adapterProfileId === "uniswap-v3-quoter-v2" || profile.adapterProfileId === "pancakeswap-v3-quoter-v2") {
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

export function joinDexMeasuredExecutionEvidence(input: {
  poolsByStablecoin: Map<string, PoolEntry[]>;
  evidence: LoadedDexMeasuredQuoteEvidence | null;
  nowSec: number;
}): DexMeasuredExecutionJoinDiagnostics {
  const diagnostics: DexMeasuredExecutionJoinDiagnostics = {
    targetCount: 0,
    measuredCount: 0,
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
        expectedTargetGenerationId: input.evidence.targetGenerationId,
        expectedQuoteGenerationId: input.evidence.quoteGenerationId,
        nowSec: input.nowSec,
      });
      const adapterIssues = deploymentIssues(quote.profile);
      const issues = [...genericIssues, ...adapterIssues];
      if (issues.length > 0) {
        delete pool.extra.measuredExecutionProfile;
        fail(mapValidationGate(issues), issues.join(","));
        continue;
      }
      pool.extra.measuredExecution = toDexMeasuredExecutionPublicProfile(quote.profile);
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
          detail: "shadow-score-ineligible",
        };
        diagnostics.measuredCount++;
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
      };
      diagnostics.measuredCount++;
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
