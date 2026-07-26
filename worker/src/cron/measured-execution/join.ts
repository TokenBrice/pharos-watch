import {
  getDexMeasuredExecutionFreshnessMaxSec,
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
import {
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_MIN_COMPLETE_CYCLES,
  CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS,
  getCurveStableSwapPolicy,
  resolveCurveStableSwapTokenIndices,
  validateCurveStableSwapProfileProof,
} from "./curve-stableswap";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES,
  CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS,
  getCurveStableSwapNgPolicy,
  validateCurveStableSwapNgProfileProof,
} from "./curve-stableswap-ng";
import {
  getCurveCompositePolicy,
  isCurveCompositeAdapterProfileId,
  validateCurveCompositeProfileProof,
} from "./curve-composite";
import {
  loadLatestPublishedDexMeasuredQuoteEvidence,
  materializeDexMeasuredQuoteProfile,
  type LoadedDexMeasuredQuoteEvidence,
} from "./persistence";
import { validateQuoterV2ProfileProof } from "./quoter-v2";
import { getDexMeasuredExecutionDeployment, isDexMeasuredExecutionDeploymentScoreEligible } from "./registry";
import { logWorkerEvent } from "../../lib/structured-log";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  getUniswapV4Deployment,
  validateUniswapV4ProfileProof,
} from "./uniswap-v4";

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
type LoadedDexMeasuredQuote = LoadedDexMeasuredQuoteEvidence["byTargetId"] extends Map<string, infer T>
  ? T
  : never;

function gate(reason: DexExecutionCapabilityGate["reason"]): DexExecutionCapabilityGate {
  return { family: "measured-execution", reason };
}

export function applyDexMeasuredExecutionGate(
  pool: PoolEntry,
  reason: DexExecutionCapabilityGate["reason"],
): void {
  pool.extra = { ...(pool.extra ?? {}) };
  if (pool.extra.ammExecutionModel) {
    if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
      delete pool.extra.executionCapabilityGate;
    }
    return;
  }
  pool.extra.executionCapabilityGate = gate(reason);
}

function increment(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

export async function loadDexMeasuredExecutionJoinEvidence(
  db: D1Database,
  signal?: AbortSignal,
): Promise<LoadedDexMeasuredQuoteEvidence | null> {
  try {
    return await loadLatestPublishedDexMeasuredQuoteEvidence(db, signal, { deferProfiles: true });
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
  if (profile.adapterProfileId === UNISWAP_V4_ADAPTER_PROFILE_ID) {
    const deployment = getUniswapV4Deployment(profile.chain);
    if (!deployment) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== deployment.endpointAddress) {
      issues.push("endpoint-address-mismatch");
    }
    if (profile.executionEndpoint.codeHash !== deployment.expectedCodeHash) {
      issues.push("endpoint-code-hash-mismatch");
    }
    issues.push(...validateUniswapV4ProfileProof(profile));
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
  if (profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID) {
    const policy = getCurveStableSwapPolicy(profile.chain, profile.executionEndpoint.address);
    if (!policy) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== policy.poolAddress) issues.push("endpoint-address-mismatch");
    if (profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash) {
      issues.push("endpoint-code-hash-mismatch");
    }
    issues.push(...validateCurveStableSwapProfileProof(profile));
    return issues;
  }
  if (profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID) {
    const policy = getCurveStableSwapNgPolicy(profile.chain, profile.executionEndpoint.address);
    if (!policy) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== policy.poolAddress) issues.push("endpoint-address-mismatch");
    if (profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash) {
      issues.push("endpoint-code-hash-mismatch");
    }
    issues.push(...validateCurveStableSwapNgProfileProof(profile));
    return issues;
  }
  if (isCurveCompositeAdapterProfileId(profile.adapterProfileId)) {
    const policy = getCurveCompositePolicy(profile.chain, profile.executionEndpoint.address);
    if (!policy) return ["deployment-missing"];
    const issues: string[] = [];
    if (profile.executionEndpoint.address !== policy.poolAddress) {
      issues.push("endpoint-address-mismatch");
    }
    if (profile.executionEndpoint.codeHash !== policy.expectedPoolCodeHash) {
      issues.push("endpoint-code-hash-mismatch");
    }
    issues.push(...validateCurveCompositeProfileProof(profile));
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
        const targetIds = pool.extra?.measuredExecutionTargets?.map((target) => target.targetId) ?? [];
        const targetId = pool.extra?.measuredExecutionTarget?.targetId;
        return targetId ? [...targetIds, targetId] : targetIds;
      }),
    ),
  );
}

function currentPhysicalPoolKeys(poolsByStablecoin: ReadonlyMap<string, readonly PoolEntry[]>): Set<string> {
  return new Set(
    [...poolsByStablecoin.entries()].flatMap(([stablecoinId, pools]) =>
      pools.flatMap((pool) => {
        const packetTargets = pool.extra?.measuredExecutionTargets ?? [];
        const target = pool.extra?.measuredExecutionTarget;
        const physicalPoolIds = [
          pool.poolId,
          pool.extra?.measuredExecutionPhysicalPoolId,
          ...packetTargets.map((measuredTarget) => measuredTarget.poolId),
          ...(target ? [target.poolId] : []),
        ].filter((poolId): poolId is string => Boolean(poolId));
        return [...new Set(physicalPoolIds)].map(
          (poolId) => `${stablecoinId}:${pool.chain.toLowerCase()}:${poolId.toLowerCase()}`,
        );
      }),
    ),
  );
}

function isMatureFreshCurveStableSwapQuote(
  quote: LoadedDexMeasuredQuote,
  nowSec: number,
): boolean {
  const history = quote.observationHistory;
  if (
    quote.quotedTarget.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID ||
    history == null
  ) return false;
  const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
    quote.quotedTarget.adapterProfileId,
  );
  return (
    history.completeProducerCycleCount >= CURVE_STABLESWAP_MIN_COMPLETE_CYCLES &&
    history.successfulObservationCount >= CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS &&
    nowSec - history.observationWindowEndedAt <= freshnessMaxSec &&
    history.observationWindowEndedAt <= nowSec + 60
  );
}

function isMatureFreshCurveStableSwapNgQuote(
  quote: LoadedDexMeasuredQuote,
  nowSec: number,
): boolean {
  const history = quote.observationHistory;
  if (
    quote.quotedTarget.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID ||
    history == null
  ) return false;
  const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
    quote.quotedTarget.adapterProfileId,
  );
  return (
    history.completeProducerCycleCount >= CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES &&
    history.successfulObservationCount >= CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS &&
    nowSec - history.observationWindowEndedAt <= freshnessMaxSec &&
    history.observationWindowEndedAt <= nowSec + 60
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

  const curvePackets = new Map<
    string,
    Array<{
      targetId: string;
      quote: LoadedDexMeasuredQuote;
      profile: DexMeasuredExecutionProfile;
    }>
  >();
  for (const [targetId, quote] of entries) {
    const target = quote.quotedTarget;
    if (
      currentTargetIds.has(targetId) ||
      quote.resolution !== "last-known-good" ||
      quote.status !== "measured" ||
      !isMatureFreshCurveStableSwapQuote(quote, input.nowSec) ||
      !input.poolsByStablecoin.has(target.stablecoinId)
    ) {
      continue;
    }
    const profile = materializeDexMeasuredQuoteProfile(quote);
    if (profile == null) continue;
    const key = [
      target.stablecoinId,
      profile.chain.toLowerCase(),
      profile.poolId.toLowerCase(),
      profile.targetGenerationId,
      profile.quoteGenerationId,
      profile.blockNumber,
      profile.tokenIn.address,
    ].join("|");
    const packet = curvePackets.get(key) ?? [];
    packet.push({ targetId, quote, profile });
    curvePackets.set(key, packet);
  }

  for (const packet of curvePackets.values()) {
    if (packet.length !== 2) continue;
    const targets = packet.map(({ quote }) => quote.quotedTarget);
    const measuredProfiles = packet.map(({ profile }) => profile);
    if (
      targets.some(
        (target) =>
          target.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID ||
          target.stablecoinId !== targets[0]!.stablecoinId ||
          target.poolId !== targets[0]!.poolId ||
          !resolveCurveStableSwapTokenIndices(target).ok,
      ) ||
      new Set(targets.map((target) => target.tokenOut.address)).size !== 2 ||
      new Set(measuredProfiles.map((profile) => profile.tokenIn.address)).size !== 1 ||
      new Set(measuredProfiles.map((profile) => profile.tokenOut.address)).size !== 2
    ) {
      continue;
    }
    const issues = packet.flatMap(({ quote }, index) => [
      ...validateDexMeasuredExecutionProfile({
        profile: measuredProfiles[index],
        quotedTarget: quote.quotedTarget,
        currentTarget: quote.quotedTarget,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec: input.nowSec,
      }),
      ...deploymentIssues(measuredProfiles[index]!),
    ]);
    if (issues.length > 0) continue;

    const profile = measuredProfiles[0]!;
    const stablecoinId = targets[0]!.stablecoinId;
    const physicalPoolKey =
      `${stablecoinId}:${profile.chain.toLowerCase()}:${profile.poolId.toLowerCase()}`;
    if (currentPoolKeys.has(physicalPoolKey) || retainedPoolKeys.has(physicalPoolKey)) continue;
    retainedPoolKeys.add(physicalPoolKey);
    const pools = retained.get(stablecoinId) ?? [];
    pools.push({
      poolId: profile.poolId,
      project: profile.protocol,
      chain: profile.chain,
      tvlUsd: Math.min(...measuredProfiles.map((candidate) => candidate.retainedTvlUsdAtQuote)),
      symbol: `${profile.tokenIn.symbol}-${measuredProfiles.map((candidate) => candidate.tokenOut.symbol).join("/")}`,
      volumeUsd1d: 0,
      poolType: "curve-stableswap-measured-retained",
      source: "dl",
      price: profile.tokenIn.referencePriceUsd,
      extra: {
        measuredExecutionTargets: targets,
        measuredExecutions: packet.map(({ quote }, index) =>
          toDexMeasuredExecutionPublicProfile(measuredProfiles[index]!, {
            observationHistory: quote.observationHistory!,
          })
        ),
        measuredExecutionPhysicalPoolId: profile.poolId,
        measuredExecutionDiagnostics: packet.map(({ targetId, quote }) => ({
          adapterProfileId: quote.quotedTarget.adapterProfileId,
          targetId,
          detail: `route-retained-after:${quote.latestFailureReason ?? "shortlist-rotation"}`,
        })),
      },
    });
    retained.set(stablecoinId, pools);
  }

  for (const [targetId, quote] of entries) {
    const target = quote.quotedTarget;
    if (
      currentTargetIds.has(targetId) ||
      quote.resolution !== "last-known-good" ||
      quote.status !== "measured" ||
      !input.poolsByStablecoin.has(target.stablecoinId)
    ) {
      continue;
    }
    if (
      target.adapterProfileId !== "uniswap-v3-quoter-v2" &&
      target.adapterProfileId !== "pancakeswap-v3-quoter-v2" &&
      target.adapterProfileId !== "aerodrome-slipstream-quoter-v2" &&
      target.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
    ) {
      continue;
    }
    const historyMature =
      target.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
        ? isMatureFreshCurveStableSwapNgQuote(quote, input.nowSec)
        : isDexMeasuredExecutionObservationHistoryMature(quote.observationHistory);
    if (!historyMature) continue;
    const profile = materializeDexMeasuredQuoteProfile(quote);
    if (profile === null) continue;
    if (
      profile.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID &&
      !isDexMeasuredExecutionDeploymentScoreEligible(profile.adapterProfileId, profile.chain)
    ) continue;
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
            : profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
              ? "curve-stableswap-ng-measured-retained"
            : "uniswap-v3-measured-retained",
      source:
        profile.adapterProfileId === "uniswap-v3-quoter-v2" ||
        profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
          ? "dl"
          : "direct_api",
      price: profile.tokenIn.referencePriceUsd,
      extra: {
        measuredExecutionTarget: target,
        measuredExecution: toDexMeasuredExecutionPublicProfile(profile, {
          observationHistory: quote.observationHistory,
        }),
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
      const packetTargets = pool.extra?.measuredExecutionTargets;
      if (packetTargets && packetTargets.length > 0) {
        diagnostics.targetCount += packetTargets.length;
        pool.extra = { ...(pool.extra ?? {}) };
        delete pool.extra.measuredExecutions;
        delete pool.extra.measuredExecutionProfiles;
        pool.extra.measuredExecutionPhysicalPoolId = packetTargets[0]!.poolId;
        const failPacket = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
          pool.extra!.measuredExecutionDiagnostics = packetTargets.map((target) => ({
            adapterProfileId: target.adapterProfileId,
            targetId: target.targetId,
            ...(detail ? { detail: detail.slice(0, 300) } : {}),
          }));
          diagnostics.gatedCount += packetTargets.length;
          for (const target of packetTargets) {
            increment(diagnostics.failuresByReason, `${target.adapterProfileId}:${reason}`);
          }
          applyDexMeasuredExecutionGate(pool, reason);
        };
        const packetPolicyValid =
          packetTargets.length === 2 &&
          packetTargets.every(
            (target) =>
              target.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID &&
              target.stablecoinId === packetTargets[0]!.stablecoinId &&
              target.poolId === packetTargets[0]!.poolId &&
              resolveCurveStableSwapTokenIndices(target).ok,
          ) &&
          new Set(packetTargets.map((target) => target.tokenOut.address)).size === 2;
        if (!packetPolicyValid) {
          failPacket("invalid-observation", "invalid-atomic-direction-packet");
          continue;
        }
        if (!input.evidence) {
          failPacket("quote-missing");
          continue;
        }
        const packet = packetTargets.map((target) => ({
          target,
          quote: input.evidence!.byTargetId.get(target.targetId),
          profile: null as DexMeasuredExecutionProfile | null,
        }));
        if (packet.some(({ quote }) => !quote)) {
          failPacket("quote-missing", "atomic-direction-missing");
          continue;
        }
        for (const entry of packet) {
          entry.profile = entry.quote ? materializeDexMeasuredQuoteProfile(entry.quote) : null;
        }
        if (packet.some(({ quote, profile }) => quote!.status !== "measured" || !profile)) {
          failPacket(
            "quote-failed",
            packet.map(({ target, quote }) => `${target.targetId}:${quote!.failureReason ?? "profile-missing"}`).join(","),
          );
          continue;
        }
        const issues = packet.flatMap(({ target, quote, profile }) => [
          ...validateDexMeasuredExecutionProfile({
            profile,
            quotedTarget: quote!.quotedTarget,
            currentTarget: target,
            expectedTargetGenerationId: quote!.targetGenerationId,
            expectedQuoteGenerationId: quote!.quoteGenerationId,
            nowSec: input.nowSec,
          }),
          ...deploymentIssues(profile!),
        ]);
        if (issues.length > 0) {
          failPacket(mapValidationGate(issues), issues.join(","));
          continue;
        }
        const profiles = packet.map(({ profile }) => profile!);
        if (
          new Set(profiles.map((profile) => profile.quoteGenerationId)).size !== 1 ||
          new Set(profiles.map((profile) => profile.targetGenerationId)).size !== 1 ||
          new Set(profiles.map((profile) => profile.blockNumber)).size !== 1 ||
          new Set(profiles.map((profile) => profile.poolId)).size !== 1 ||
          new Set(profiles.map((profile) => profile.tokenIn.address)).size !== 1
        ) {
          failPacket("generation-mismatch", "atomic-direction-generation-mismatch");
          continue;
        }
        pool.extra.measuredExecutions = packet.map(({ quote, profile }) =>
          toDexMeasuredExecutionPublicProfile(profile!, {
            ...(quote!.observationHistory ? { observationHistory: quote!.observationHistory } : {}),
          })
        );
        pool.extra.measuredExecutionPhysicalPoolId = profiles[0]!.poolId;
        pool.extra.measuredExecutionDiagnostics = packet.map(({ target, quote }) => ({
          adapterProfileId: target.adapterProfileId,
          targetId: target.targetId,
          ...(quote!.resolution === "last-known-good"
            ? { detail: `last-known-good-after:${quote!.latestFailureReason ?? "quote-missing"}` }
            : {}),
        }));
        if (pool.extra.executionCapabilityGate?.family === "measured-execution") {
          delete pool.extra.executionCapabilityGate;
        }
        diagnostics.measuredCount += packetTargets.length;
        diagnostics.lastKnownGoodCount += packet.filter(
          ({ quote }) => quote!.resolution === "last-known-good",
        ).length;
        continue;
      }
      const target = pool.extra?.measuredExecutionTarget;
      if (!target) continue;
      diagnostics.targetCount++;
      pool.extra = { ...(pool.extra ?? {}) };
      delete pool.extra.measuredExecution;
      delete pool.extra.measuredExecutionProfile;
      pool.extra.measuredExecutionPhysicalPoolId = target.poolId;
      const fail = (reason: DexExecutionCapabilityGate["reason"], detail?: string) => {
        applyDexMeasuredExecutionGate(pool, reason);
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
      const profile = materializeDexMeasuredQuoteProfile(quote);
      if (quote.status !== "measured" || !profile) {
        fail("quote-failed", quote.failureReason ?? undefined);
        continue;
      }
      const genericIssues = validateDexMeasuredExecutionProfile({
        profile,
        quotedTarget: quote.quotedTarget,
        currentTarget: target,
        expectedTargetGenerationId: quote.targetGenerationId,
        expectedQuoteGenerationId: quote.quoteGenerationId,
        nowSec: input.nowSec,
      });
      const adapterIssues = deploymentIssues(profile);
      const issues = [...genericIssues, ...adapterIssues];
      if (issues.length > 0) {
        fail(mapValidationGate(issues), issues.join(","));
        continue;
      }
      pool.extra.measuredExecution = toDexMeasuredExecutionPublicProfile(profile, {
        ...(quote.observationHistory ? { observationHistory: quote.observationHistory } : {}),
      });
      const lastKnownGoodDetail =
        quote.resolution === "last-known-good"
          ? `last-known-good-after:${quote.latestFailureReason ?? "quote-missing"}`
          : undefined;
      const curvePolicy =
        profile.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID
          ? getCurveCryptoSwapShadowPolicy(profile.chain, profile.executionEndpoint.address)
          : null;
      const curveCompositePolicy = isCurveCompositeAdapterProfileId(profile.adapterProfileId)
        ? getCurveCompositePolicy(profile.chain, profile.executionEndpoint.address)
        : null;
      const activationPending =
        profile.adapterProfileId === FLUID_RESOLVER_ADAPTER_PROFILE_ID ||
        profile.adapterProfileId === UNISWAP_V4_ADAPTER_PROFILE_ID ||
        (profile.adapterProfileId === CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID
          ? !curvePolicy?.scoreEligible
          : profile.adapterProfileId === CURVE_STABLESWAP_ADAPTER_PROFILE_ID
            ? false
            : profile.adapterProfileId === CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID
              ? false
              : isCurveCompositeAdapterProfileId(profile.adapterProfileId)
                ? !curveCompositePolicy?.scoreEligible
          : !isDexMeasuredExecutionDeploymentScoreEligible(profile.adapterProfileId, profile.chain));
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

export function releaseDexMeasuredExecutionProofFields(pools: readonly PoolEntry[]): void {
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.measuredExecutionTarget;
    delete pool.extra.measuredExecutionTargets;
    delete pool.extra.measuredExecutionProfile;
    delete pool.extra.measuredExecutionProfiles;
    delete pool.extra.measuredExecutionDiagnostic;
    delete pool.extra.measuredExecutionDiagnostics;
  }
}

export function stripDexMeasuredExecutionInternalFields(pools: readonly PoolEntry[]): void {
  releaseDexMeasuredExecutionProofFields(pools);
  for (const pool of pools) {
    if (!pool.extra) continue;
    delete pool.extra.measuredExecutions;
    delete pool.extra.measuredExecutionPhysicalPoolId;
  }
}
