import { describe, expect, it, vi } from "vitest";
import { fixedFee, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstop-configs/shared";
import * as redemptionBackstops from "@shared/lib/redemption-backstops";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { DEX_ROUTE_CAPABILITY_MATRIX_VERSION } from "@shared/lib/p4-exit-route-capability-policy";
import { isDexExitPayoutConversion } from "@shared/lib/exit-route-output";
import { buildV9DependencyEvaluationPlan } from "@shared/lib/safety-score-v9/dependencies";
import { classifyV9DocumentationGap } from "@shared/lib/safety-score-v9/documentation";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { buildV9EvidenceGapQueue } from "@shared/lib/safety-score-v9/evidence-gap-queue";
import { evaluateV9Exit, projectV9ExitEvaluationRoute, selectV9ExitCirculatingUsd } from "@shared/lib/safety-score-v9/exit";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import * as methodologyPolicy from "@shared/lib/safety-score-v9/policy";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import * as exitExecution from "@shared/lib/safety-score-v9/exit-execution";
import reviewedExecutionModels from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { withRedemptionBackstopConfig } from "./safety-score-v9-extension-routes.test-support";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { compileRouteFactorStatuses, createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { createV9EvidenceReference } from "@shared/lib/safety-score-v9/evidence";
import { makeExecutionCertificate } from "@shared/lib/__tests__/safety-score-v9-exit-execution.test-support";
import {
  compileSafetyScoreV9FactSetFromFixedInput as compileFS,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildSafetyScoreV9RetainedRedemptionRoutes, buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9BoundedUnknownFeeRedemptionFixedInput as boundedUnknownFeeRedemptionFixedInput,
  makeV9FixedInput as exactFixedInput,
  makeV9Extension as extension,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9RouteReview as routeReview,
  v9ExitRouteObservation,
  v9Status,
} from "../../test-helpers/v9-fixed-input";
import { buildRoutes } from "../safety-score-v9/fact-set-exit";
import { captureRedemptionReserveQuarantine } from "../safety-score-v9/redemption-reserve-quarantine";
import { buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";

const P = V9_CANDIDATE_POLICY_V1;
type FixedDraft = ReturnType<typeof exactFixedInput>;
type CompiledAsset = ReturnType<typeof compileFS>["assets"][number];
const redemptionOf = <T extends { lane: string }>(routes: readonly T[]) => routes.find((route) => route.lane === "redemption")!;
const capturedRedemption = (fixed: FixedDraft) => fixed.redemptionBackstopMap.alpha!.capacityProfile!.exitRouteObservations![0]!;
const capturedDex = (fixed: FixedDraft) => fixed.dexLiqMap.alpha!.exitRouteObservations![0]!;
const VERIFIED_NO_POOLS = {
  totalSupplyUsd: 10_000_000, verifiedNoPoolsSupplyUsd: 10_000_000, verifiedNoPoolsSupplyRatio: 1,
  observedSupplyUsd: 0, observedSupplyRatio: 0, providerInaccessibleSupplyUsd: 0,
  providerInaccessibleSupplyRatio: 0, unknownSupplyUsd: 0, unknownSupplyRatio: 0, unknownChains: [] as string[],
};
const emptyDexCov = (extra?: Partial<NonNullable<NonNullable<FixedDraft["dexLiqMap"][string]>["exitRouteObservationCoverage"]>>) => ({
  status: "populated" as const, capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION,
  retainedPoolCount: 0, observationCount: 0, scoreEligibleObservationCount: 0,
  scoreEligiblePoolCount: 0, unsupportedPoolCount: 0, evidenceCounts: {}, unsupportedReasons: {}, ...extra,
});
function attachRedemption(
  draft: FixedDraft, assetId: string, row: NonNullable<FixedDraft["redemptionBackstopMap"][string]>, generationId: string, updatedAt = draft.clockSec,
) {
  draft.redemptionBackstopMap = { ...draft.redemptionBackstopMap, [assetId]: row };
  draft.redemptionGenerationId = generationId;
  draft.redemptionStale = false;
  draft.inputFreshness.redemptionBackstops = { updatedAt, ageSeconds: 0, stale: false };
}
function reviewedFor(
  fixed: FixedDraft,
  opts?: { assetId?: string; withClock?: boolean; routeReviews?: boolean; retained?: boolean; emptyRoutes?: boolean },
) {
  const assetId = opts?.assetId ?? "alpha";
  const rev = structuredClone(extension({
    ...(opts?.assetId ? { assetId } : {}),
    ...(opts?.withClock ? { clockSec: fixed.clockSec } : {}),
    registryFingerprint: fixed.registryFingerprint,
  }));
  if (opts?.emptyRoutes) rev.assets[0]!.routeReviews = [];
  else if (opts?.routeReviews) rev.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, assetId);
  if (opts?.retained) rev.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, assetId);
  return rev;
}
function compileReviewedRoutes(fixed: FixedDraft, reviewed = reviewedFor(fixed, { routeReviews: true })) {
  return compileFS(fixed, reviewed).assets[0]!.exitRoutes;
}
function compileIsolated(fixed: FixedDraft, reviewed: ReturnType<typeof extension>) {
  const normalized = normalizeSafetyScoreV9CompilerInput(fixed);
  return compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
    normalized, materializeSafetyScoreV9FactSetExtension(normalized, reviewed),
  );
}
function evalExitFor(
  asset: CompiledAsset, routes = asset.exitRoutes,
  extra?: { circulatingUsd?: number; portfolioStatus?: Parameters<typeof evaluateV9Exit>[0]["portfolioStatus"] },
) {
  return evaluateV9Exit({
    circulatingUsd: extra?.circulatingUsd ?? asset.supply.circulatingUsd,
    ...(extra?.portfolioStatus ? { portfolioStatus: extra.portfolioStatus } : {}),
    gaps: asset.gaps, portfolioFactStatus: asset.exitStatus, routes: routes.map(projectV9ExitEvaluationRoute),
  }, P);
}

describe("route compiler policy reuse", () => {
  it("resolves one policy per fixed input without leaking another capture's clock", () => {
    const first = factBuilderContext();
    const second = factBuilderContext(exactFixedInput({ clockSec: first.fixedInput.clockSec + 3_600 }));
    const loadPolicy = vi.spyOn(methodologyPolicy, "loadV9CandidateMethodologyPolicy");
    const validateReviews = vi.spyOn(exitExecution, "validateExitExecutionModelReviews");
    try {
      buildRoutes(first, buildSupply(first));
      buildRoutes({ ...first, evidence: new Map(), gaps: new Map() }, buildSupply(first));
      expect(loadPolicy).toHaveBeenCalledTimes(1);
      expect(loadPolicy).toHaveBeenLastCalledWith(first.fixedInput.clockSec);
      buildRoutes(second, buildSupply(second));
      expect(loadPolicy).toHaveBeenCalledTimes(2);
      expect(loadPolicy).toHaveBeenLastCalledWith(second.fixedInput.clockSec);
      expect(validateReviews).toHaveBeenCalledTimes(1);
    } finally {
      loadPolicy.mockRestore();
      validateReviews.mockRestore();
    }
  });
});

describe("route evidence independent of sizing and status labels", () => {
  it("uses maximum stress with stale supply while preserving original evidence clocks", () => {
    const draft = structuredClone(queuedRedemptionFixedInput());
    const supplyObservedAt = draft.aggregateCirculatingById.alpha!.observedAtSec!;
    draft.clockSec += 100_000;
    draft.inputFreshness.dexLiquidity.ageSeconds =
      draft.clockSec - draft.inputFreshness.dexLiquidity.updatedAt!;
    draft.inputFreshness.dexLiquidity.stale = true;
    draft.liquidityStale = true;
    const row = draft.redemptionBackstopMap.alpha!;
    row.updatedAt = draft.clockSec;
    row.sourceTimestamp = draft.clockSec;
    draft.inputFreshness.redemptionBackstops = {
      updatedAt: draft.clockSec, ageSeconds: 0, stale: false,
    };
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    observation.observedAt = draft.clockSec;
    observation.freshnessSeconds = 0;
    observation.capacityCurve!.push({
      requestedNotionalUsd: 25_000_000, maxCostBps: 200,
      executableUsd: 1_000_000, completionRatio: 0.04,
    });
    const routeObservedAt = observation.observedAt;
    const fixed = rebuildFixed(draft);
    const reviewed = reviewedFor(fixed, { withClock: true, routeReviews: true });
    reviewed.sources.chainSupply.observedAtSec = supplyObservedAt;
    const context = factBuilderContext(fixed, reviewed);
    const supply = buildSupply(context);
    const built = buildRoutes(context, supply);
    const result = evaluateV9Exit({
      circulatingUsd: selectV9ExitCirculatingUsd(supply),
      routes: built.exitRoutes.map(projectV9ExitEvaluationRoute), gaps: [...context.gaps.values()],
    }, V9_CANDIDATE_POLICY_V1);
    expect(selectV9ExitCirculatingUsd(supply)).toBeNull();
    expect(result.stressRequest?.requestedNotionalUsd).toBe(25_000_000);
    const route = redemptionOf(built.exitRoutes);
    expect(result.routes.find((candidate) => candidate.routeKey === route.routeKey)?.included).toBe(true);
    expect(context.evidence.get(route.status.evidenceRefIds[0]!)?.observedAtSec).toBe(routeObservedAt);
    expect(fixed.aggregateCirculatingById.alpha!.observedAtSec).toBe(supplyObservedAt);
  });

  it.each([
    { routeStatus: "open", evidenceKind: "onchain-contract-state", admitted: true },
    { routeStatus: "unknown", evidenceKind: "onchain-contract-state", admitted: true },
    { routeStatus: "paused", evidenceKind: "onchain-contract-state", admitted: false },
    { routeStatus: "suspended", evidenceKind: "onchain-contract-state", admitted: false },
    { routeStatus: "open", evidenceKind: "documented-terms", admitted: false },
  ] as const)("uses execution, not status labels: $routeStatus / $evidenceKind", ({ routeStatus, evidenceKind, admitted }) => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, true));
    const row = draft.redemptionBackstopMap.alpha!;
    Object.assign(row, { routeStatus, routeStatusSource: "static-config", sourceMode: "dynamic",
      capacityKind: "live-direct", settlementModel: "atomic", settlementDelaySec: 0,
      accessModel: "permissionless-onchain", holderEligibility: "any-holder", feeBps: 0 });
    const observation = row.capacityProfile!.exitRouteObservations![0]!;
    observation.evidenceKind = evidenceKind;
    if (routeStatus === "unknown") observation.scoreEligible = false;
    const fixed = rebuildFixed(draft);
    const reviewed = reviewedFor(fixed, { withClock: true, routeReviews: true });
    const context = factBuilderContext(fixed, reviewed);
    const route = redemptionOf(buildRoutes(context, buildSupply(context)).exitRoutes);
    expect(route.status.observationState).toBe(routeStatus === "paused" || routeStatus === "suspended" ? "unsupported" : "known");
    if (routeStatus === "open" || routeStatus === "unknown") expect(route.coverageClass).toBe(admitted ? "exact-lower-bound" : "diagnostic");
    const result = evaluateV9Exit({ circulatingUsd: 20_000_000, gaps: [...context.gaps.values()],
      routes: [projectV9ExitEvaluationRoute(route)] }, V9_CANDIDATE_POLICY_V1);
    expect(result.primaryRouteKey === route.routeKey).toBe(admitted);
  });
});

describe("configured redemption channel census", () => {
  const clockSec = Date.parse("2026-10-20T12:00:00Z") / 1_000;
  const config: RedemptionBackstopConfig = {
    routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "days",
    executionModel: "rules-based-nav", outputAssetType: "stable-single",
    capacityModel: { kind: "unquantified" },
    costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" },
    reviewedAt: "2026-10-03",
    docs: [{ label: "Issuer redemption terms", url: "https://example.com/redemption", supports: ["route"] }],
    v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: ["capacity", "cost", "settlement"],
      rationale: "A real primary channel exists but funded capacity, all-in cost and completed payout are unquantified.",
      reviewedAt: "2026-10-03",
      docs: [{ label: "Issuer redemption terms", url: "https://example.com/redemption", supports: ["route"] }],
    },
  };

  function emptyDexContext(withMeasuredZeroDex = false, rowState?: "missing-capacity" | "impaired") {
    const draft = exactFixedInput({ clockSec });
    if (withMeasuredZeroDex) {
      const obs = capturedDex(draft);
      obs.executableUsd = 0; obs.completionRatio = 0;
      obs.capacityCurve = obs.capacityCurve!.map((p) => ({ ...p, executableUsd: 0, completionRatio: 0 }));
    } else {
      draft.dexLiqMap.alpha!.exitRouteObservations = [];
      draft.dexLiqMap.alpha!.exitRouteObservationCoverage = emptyDexCov();
    }
    draft.dexDeploymentSupplyCoverageById.alpha = { ...VERIFIED_NO_POOLS };
    if (rowState) {
      attachRedemption(draft, "alpha", makeSupplyFullRedemption({ stablecoinId: "alpha", resolutionState: rowState, capacityProfile: undefined, updatedAt: clockSec }), "redemption:configured-channel-census", clockSec);
    }
    const fixed = rebuildFixed(draft);
    const reviewed = reviewedFor(fixed, { withClock: true, emptyRoutes: !withMeasuredZeroDex });
    if (withMeasuredZeroDex) reviewed.assets[0]!.routeReviews[0]!.coverageClass = "exact-complete";
    return factBuilderContext(fixed, reviewed);
  }

  it.each(["unquantified-row", "absent-row", "impaired-row", "measured-zero-dex"] as const)(
    "retains unavailable primary-channel evidence without capacity credit: %s", (scenario) => {
      const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(config);
      try {
        const context = emptyDexContext(scenario === "measured-zero-dex",
          scenario === "unquantified-row" ? "missing-capacity" : scenario === "impaired-row" ? "impaired" : undefined);
        const compiled = buildRoutes(context, buildSupply(context));
        const channel = redemptionOf(compiled.exitRoutes);
        expect(channel).toMatchObject({
          routeId: "redemption:alpha:offchain-issuer", routeFamily: "issuer-redemption",
          scoreEligible: false, coverageClass: "diagnostic", request: null, capacityCurve: [],
          settlementSlaSec: null, status: { observationState: "missing" },
          output: { kind: "unknown", valuation: null },
        });
        expect(context.evidence.get("alpha:redemption-configured-channel")).toMatchObject({
          observedAtSec: Date.parse("2026-10-03") / 1_000,
          sourceGenerationId: context.extension.sources.researchOverlays.generationId,
        });
        expect(compiled.exitStatus.observationState).toBe("bounded-unknown");
        const evaluated = evaluateV9Exit({
          circulatingUsd: 10_000_000, portfolioFactStatus: compiled.exitStatus,
          gaps: [...context.gaps.values()], routes: compiled.exitRoutes.map(projectV9ExitEvaluationRoute),
        }, V9_CANDIDATE_POLICY_V1);
        expect(evaluated.score).toBe(50);
        expect(evaluated.reasons).toContain("missing-same-notional-route");
        expect(evaluated.reasons).not.toContain("no-viable-exit-path");
        expect(evaluated.routes.find((route) => route.routeKey === channel.routeKey)).toMatchObject({
          included: false, capacityPoint: null,
        });
        if (scenario === "measured-zero-dex") {
          expect(evaluated.routes.find((route) => route.lane === "dex")!.exclusionReason).toBe("missing-same-notional-route");
          expect(evaluated.routes.find((route) => route.lane === "dex")).toMatchObject({ included: false, score: 0 });
        }
      } finally {
        getConfig.mockRestore();
      }
    },
  );

  it.each([
    { name: "absent config", value: null },
    { name: "uncited config", value: { ...config, docs: [] } },
    { name: "same-day review", value: { ...config, reviewedAt: "2026-10-20" } },
    { name: "future review", value: { ...config, reviewedAt: "2026-10-21" } },
  ])("does not create a channel from $name", ({ value }) => {
    const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(value);
    try {
      const context = emptyDexContext();
      const compiled = buildRoutes(context, buildSupply(context));
      expect(compiled.exitRoutes).toEqual([]);
      expect(compiled.exitStatus.observationState).toBe("known");
      expect(context.evidence.has("alpha:redemption-configured-channel")).toBe(false);
    } finally {
      getConfig.mockRestore();
    }
  });

  const baseSourced: RedemptionBackstopConfig = {
    routeFamily: "stablecoin-redeem", accessModel: "permissionless-onchain", holderEligibility: "any-holder",
    executionModel: "deterministic-onchain", settlementModel: "atomic", outputAssetType: "stable-single",
    outputAssets: ["usdc-circle"], capacityModel: { kind: "unquantified" }, costModel: fixedFee(25), reviewedAt: "2026-10-03",
    docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["route", "access", "settlement", "fees"] }],
  };

  function compileUnavailableChannel(
    overrideConfig: RedemptionBackstopConfig,
    opts?: { assetId?: string; atClockSec?: number; withOutputPeg?: boolean; staleOutputPeg?: boolean; liveDirectMissingCapacity?: boolean },
  ) {
    const assetId = opts?.assetId ?? "alpha", atClockSec = opts?.atClockSec ?? clockSec;
    const draft = exactFixedInput({ assetId, clockSec: atClockSec });
    draft.dexLiqMap[assetId]!.exitRouteObservations = [];
    draft.dexLiqMap[assetId]!.exitRouteObservationCoverage = emptyDexCov();
    if (opts?.withOutputPeg !== false) {
      const obs = opts?.staleOutputPeg ? atClockSec - 400 * 86_400 : atClockSec - 60;
      draft.pegDataById["usdc-circle"] = { ...draft.pegDataById[assetId]!, id: "usdc-circle", symbol: "USDC", pegCurrency: "USD", currentDeviationBps: 0, priceObservedAt: obs, priceUpdatedAt: obs };
    }
    if (opts?.liveDirectMissingCapacity) {
      attachRedemption(draft, assetId, {
        ...makeSupplyFullRedemption({ stablecoinId: assetId, resolutionState: "missing-capacity", capacityProfile: undefined, updatedAt: atClockSec }),
        provider: "reserve-sync-metadata", capacityBasis: "live-direct-telemetry", routeStatus: "open",
      }, "redemption:live-direct-missing", atClockSec);
    }
    const fixed = rebuildFixed(draft), reviewed = reviewedFor(fixed, { assetId, withClock: true, emptyRoutes: true });
    const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(overrideConfig);
    try {
      const factSet = compileFS(fixed, reviewed), asset = factSet.assets[0]!;
      return { asset, route: redemptionOf(asset.exitRoutes), evaluated: evaluateV9FactSet(factSet, P).assets[0]! };
    } finally {
      getConfig.mockRestore();
    }
  }

  const expectStates = (route: ReturnType<typeof compileUnavailableChannel>["route"], states: Record<string, string>) => {
    for (const [k, v] of Object.entries(states)) {
      expect(route.factorStatuses[k as keyof typeof route.factorStatuses]?.observationState, k).toBe(v);
    }
  };

  it("projects reviewed, sourced, current non-capacity terms onto an unavailable rail while keeping capacity and measurement confidence unknown", () => {
    const docs: NonNullable<RedemptionBackstopConfig["docs"]> = [{ label: "Verified contract and terms", url: "https://example.com/terms", supports: ["route", "access", "settlement", "fees"] }];
    const { route, evaluated } = compileUnavailableChannel({
      ...baseSourced, costModel: fixedFee(4900, "Fixed 4,900 bps discount"), docs,
      v9RouteReviewTerms: {
        scoringDisposition: "bounded-terms-gap", missingScoringFields: ["capacity"], reviewedAt: "2026-10-03",
        rationale: "Payout, access, atomic settlement, and fixed rate are verified; raw capacity is unquantified.",
        docs,
      },
    });
    expect(route).toMatchObject({
      holderAccess: "permissionless", executionModel: "deterministic", executionCertainty: "unknown",
      modelConfidence: "unknown", observationConfidence: "unknown", capacityEvidenceTier: "unknown",
      settlementModel: "atomic", settlementSlaSec: 0, scoreEligible: false, coverageClass: "diagnostic",
      request: null, capacityCurve: [],
      output: { status: { observationState: "known" }, kind: "tracked-stablecoin", assetKeys: ["usdc-circle"] },
    });
    expect(route.output.valuation).not.toBeNull();
    expectStates(route, {
      access: "known", holderEligibility: "known", settlement: "known", cost: "known", output: "known",
      capacity: "missing", capacityEvidenceTier: "missing", observationConfidence: "missing", executionConfidence: "missing",
    });
    expect(evaluated.exit).toMatchObject({ score: 50, primaryRouteKey: null });
    expect(evaluated.exit.reasons).not.toContain("unresolved-exit-output");
    expect(evaluated.exit.reasons).toContain("missing-runtime-route-evidence");
  });

  it("projects reviewed settlementDelaySec, publishedFeeSchedule, and non-rejected terms evidence on live-direct missing-capacity rails", () => {
    const { asset, route, evaluated } = compileUnavailableChannel({
      routeFamily: "queue-redeem", accessModel: "whitelisted-onchain", holderEligibility: "whitelisted-primary",
      executionModel: "rules-based-nav", settlementModel: "queued", outputAssetType: "stable-single",
      outputAssets: ["usdc-circle"], capacityModel: { kind: "reserve-sync-metadata", requiredOutputAssetKeys: ["usdc-circle"] },
      costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "documented-variable", feeBpsMin: 0, feeBpsMax: 100 },
      v9RouteCostTerms: {
        feeBpsMin: 0, feeBpsMax: 100,
        publishedFeeSchedule: {
          reviewedAt: "2026-10-03", reviewer: "test-review", rationale: "On-chain cap bounds redemption fee at 100 bps.",
          docs: [{ label: "Fee cap", url: "https://example.com/fees", supports: ["fees"] }],
        },
      },
      v9RouteReviewTerms: {
        settlementDelaySec: 259_200, minRedeemUsd: 10_000, reviewedAt: "2026-10-03",
        docs: [{ label: "Queue SLA", url: "https://example.com/sla", supports: ["settlement"] }],
      },
      reviewedAt: "2026-10-03", docs: [{ label: "Protocol docs", url: "https://example.com/docs", supports: ["route", "access"] }],
    }, { liveDirectMissingCapacity: true });
    expect(route).toMatchObject({
      holderAccess: "allowlisted", executionModel: "queued", settlementModel: "queued",
      settlementSlaSec: 259_200, minRedeemUsd: 10_000, scoreEligible: false, coverageClass: "diagnostic",
    });
    expectStates(route, { access: "known", holderEligibility: "known", settlement: "known", cost: "known", output: "known", capacity: "missing" });
    for (const key of ["access", "holderEligibility", "settlement", "cost"] as const) {
      const refs = route.factorStatuses[key]!.evidenceRefIds;
      expect(refs).toEqual(["alpha:redemption-configured-channel"]);
      expect(asset.evidence.find((e) => e.evidenceId === refs[0])?.disposition).toBe("observed");
    }
    expect(evaluated.exit.primaryRouteKey).toBeNull();
  });

  it("fails closed when terms are stale, unsourced, unpriced, explicitly missing, unknown-eligibility, collateral, or non-atomic without SLA", () => {
    const cases: Array<{
      cfg?: Partial<RedemptionBackstopConfig>;
      opts?: Parameters<typeof compileUnavailableChannel>[1];
      route?: Record<string, unknown>;
      states?: Record<string, string>;
      missingOut?: boolean;
    }> = [
      { opts: { atClockSec: Date.parse("2027-10-05T00:00:00Z") / 1_000 }, route: { holderAccess: "unknown", settlementSlaSec: null },
        states: { access: "missing", cost: "bounded-unknown", settlement: "missing" }, missingOut: true },
      { cfg: { docs: [{ label: "Route only", url: "https://example.com/route", supports: ["route"] }] },
        route: { holderAccess: "unknown", settlementSlaSec: null },
        states: { access: "missing", holderEligibility: "missing", settlement: "missing", cost: "bounded-unknown" } },
      { cfg: { holderEligibility: "unknown" }, route: { holderAccess: "unknown" }, states: { access: "missing", holderEligibility: "missing" } },
      { cfg: { v9RouteReviewTerms: {
        scoringDisposition: "bounded-terms-gap", missingScoringFields: ["capacity", "cost", "settlement"],
        rationale: "Legacy fixed fee and atomic settlement are not established for the current rail.",
        reviewedAt: "2026-10-03", docs: [{ label: "Review", url: "https://example.com/review", supports: ["route"] }],
      } }, route: { settlementSlaSec: null }, states: { settlement: "missing", cost: "bounded-unknown", access: "known" } },
      { cfg: { routeFamily: "offchain-issuer", accessModel: "issuer-api", holderEligibility: "verified-customer",
        executionModel: "rules-based-nav", settlementModel: "same-day" },
        route: { settlementSlaSec: null }, states: { settlement: "missing" } },
      { opts: { withOutputPeg: false }, missingOut: true },
      { opts: { staleOutputPeg: true }, missingOut: true },
      { cfg: { routeFamily: "collateral-redeem", outputAssetType: "mixed-collateral", outputAssets: undefined }, missingOut: true },
    ];
    for (const c of cases) {
      const { route } = compileUnavailableChannel({ ...baseSourced, ...c.cfg }, c.opts);
      if (c.route) expect(route).toMatchObject(c.route);
      if (c.states) expectStates(route, c.states);
      if (c.missingOut) {
        expect(route.output.status.observationState).toBe("missing");
        if (!c.opts?.atClockSec) expect(route.output.valuation).toBeNull();
      }
    }
  });
});

describe("reviewed execution-model gap expiry", () => {
  it.each([
    { offset: -1, expectedGap: true },
    { offset: 0, expectedGap: true },
    { offset: 1, expectedGap: false },
  ])("enumerates missing certificates through the inclusive expiry (offset $offset)", ({ offset, expectedGap }) => {
    const review = exitExecution.validateExitExecutionModelReviews(reviewedExecutionModels, V9_CANDIDATE_POLICY_V1)
      .find((entry) => V9_CANDIDATE_POLICY_V1.policy.semantic.exit.executionModels[entry.modelId]!.admission === "enabled")!;
    const assetId = review.identity.assetId;
    const clockSec = Date.parse(review.expiresAt) / 1000 + offset;
    const fixed = exactFixedInput({ assetId, clockSec });
    const context = factBuilderContext(fixed, extension({ assetId, clockSec, registryFingerprint: fixed.registryFingerprint }));
    const routes = buildRoutes(context, buildSupply(context));
    const gapId = `${assetId}:gap:exit-execution:${exitExecution.exitExecutionReviewDigest(review)}`;
    expect(routes.exitStatus.gapIds.includes(gapId)).toBe(expectedGap);
    expect(context.gaps.has(gapId)).toBe(expectedGap);
    if (expectedGap) {
      expect(context.gaps.get(gapId)).toMatchObject({
        reasonCode: "missing-runtime-route-evidence", observationState: "missing", responsibility: "unresearched",
        causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
      });
    }
  });
});

describe("explicit route factor gaps and source chronology", () => {
  function usdcRedemptionFixed(clockSec: number, row: ReturnType<typeof makeSupplyFullRedemption>, generationId: string) {
    const draft = exactFixedInput({ assetId: "usdc-circle", clockSec });
    draft.redemptionBackstopMap = {};
    attachRedemption(draft, "usdc-circle", row, generationId);
    return rebuildFixed(draft);
  }
  const compileUsdc = (fixed: FixedDraft) => compileFS(fixed, reviewedFor(fixed, { assetId: "usdc-circle", withClock: true, routeReviews: true, retained: true }));

  it.each([
    { clock: "2026-07-13T12:00:00Z", admitted: false },
    { clock: "2026-07-13T23:59:59Z", admitted: false },
    { clock: "2026-07-14T00:00:00Z", admitted: true },
  ])("admits the same date-only review in coverage and factor gates at $clock", ({ clock, admitted }) => {
    const clockSec = Date.parse(clock) / 1000;
    const fixed = usdcRedemptionFixed(clockSec, makeSupplyFullRedemption({ feeBps: 7, updatedAt: clockSec }), "redemption:review-admission");
    withRedemptionBackstopConfig("usdc-circle", { v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: ["cost"], reviewedAt: "2026-07-13",
      rationale: "The exact route cost bound has not been established.",
      docs: [{ label: "Route terms", url: "https://example.com/route", supports: ["route"] }],
    } }, () => {
      const route = redemptionOf(compileUsdc(fixed).assets[0]!.exitRoutes);
      expect(route.coverageClass).toBe("exact-lower-bound");
      expect(route.factorStatuses.cost!.observationState).toBe(admitted ? "missing" : "known");
    });
  });

  it.each([
    { factor: "cost", nonCanonical: false }, { factor: "cost", nonCanonical: true },
    { factor: "settlement", nonCanonical: false }, { factor: "settlement", nonCanonical: true },
    { factor: "capacity", nonCanonical: false }, { factor: "capacity", nonCanonical: true },
  ] as const)("preserves the $factor gap and captured diagnostics (noncanonical: $nonCanonical)", ({ factor, nonCanonical }) => {
    const assetId = "usdc-circle", clockSec = Date.UTC(2026, 6, 13) / 1000;
    const row = makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: 7 });
    if (nonCanonical) {
      const obs = buildSafetyScoreV9RetainedRedemptionRoutes({ ...exactFixedInput({ assetId, clockSec }), redemptionBackstopMap: { [assetId]: row } }, assetId)[0]!.observation;
      row.capacityProfile = { ...row.capacityProfile!, exitRouteObservations: [{ ...obs, routeId: `redemption:${assetId}:fpi-controller:ethereum` }] };
    }
    const fixed = usdcRedemptionFixed(clockSec, row, "redemption:explicit-missing-factors");
    const capturedCapacity = structuredClone(fixed.redemptionBackstopMap[assetId]!.capacityProfile);
    withRedemptionBackstopConfig(assetId, { v9RouteReviewTerms: {
      scoringDisposition: "bounded-terms-gap", missingScoringFields: [factor], reviewedAt: "2026-07-01",
      rationale: "The exact completion, cost or capacity bound has not been established.",
      docs: [{ label: "Route terms", url: "https://example.com/route", supports: ["route"] }],
    } }, () => {
      const compiled = compileUsdc(fixed), asset = compiled.assets[0]!, route = redemptionOf(asset.exitRoutes);
      if (factor === "capacity") {
        expect(route).toMatchObject({ coverageClass: "diagnostic", status: { observationState: "missing" }, request: null, capacityCurve: [], scoreEligible: false });
      } else {
        expect(route.coverageClass).toBe("exact-lower-bound");
        expect(route.capacityCurve.some((point) => point.executionCostBps === 7)).toBe(true);
      }
      expect(fixed.redemptionBackstopMap[assetId]!.capacityProfile).toEqual(capturedCapacity);
      expect(route.settlementSlaSec).toBe(0);
      expect(route.factorStatuses[factor]!.observationState).toBe("missing");
      const gap = asset.gaps.find((candidate) => route.factorStatuses[factor]!.gapIds.includes(candidate.gapId))!;
      expect(gap.causeScope).toMatchObject({ routeKey: route.routeKey, factorKey: factor, requiredDatum: factor });
      if (factor === "cost" || factor === "settlement") {
        expect(gap.policyRuleId).toBe("v9.exit.reviewed-terms");
        expect(["C", "U"]).toContain(gap.causeProof.cause);
      }
      expect(evaluateV9FactSet(compiled, P).assets[0]!.exit.causeGapIds).toContain(gap.gapId);
    });
  });

  it.each([{ feeBpsMin: 25 }, { minFeeUsd: 1_000 }])("keeps minimum-only fees in the cost cause gaps (%j)", (minimum) => {
    const fixed = usdcRedemptionFixed(Date.UTC(2026, 6, 13) / 1000, makeSupplyFullRedemption({ stablecoinId: "usdc-circle", feeBps: null }), "redemption:minimum-only-cost");
    withRedemptionBackstopConfig("usdc-circle", {
      costModel: { kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula", ...minimum },
      v9RouteReviewTerms: undefined, v9RouteCostTerms: undefined,
    }, () => {
      const compiled = compileUsdc(fixed), route = redemptionOf(compiled.assets[0]!.exitRoutes);
      expect(route.factorStatuses.cost!.observationState).toBe("missing");
      expect(evaluateV9FactSet(compiled, P).assets[0]!.exit.causeGapIds).toEqual(expect.arrayContaining(route.factorStatuses.cost!.gapIds));
    });
  });

  it.each(["older", "newer", "diagnostic", "noncanonical-older", "noncanonical-newer", "rejected", "stricter"] as const)(
    "resolves primary terms gaps only for newly admitted exact evidence (%s)", (scenario) => {
      const fixed = exactFixedInput({ assetId: "usdc-circle", clockSec: Date.UTC(2026, 6, 13) / 1000 });
      const reviewed = extension({ assetId: "usdc-circle", clockSec: fixed.clockSec, registryFingerprint: fixed.registryFingerprint });
      const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixed), reviewed, reviewed.assets[0]!, "a".repeat(64));
      const base = compileFS(exactFixedInput(), extension()).assets[0]!.exitRoutes[0]!;
      const certificate = makeExecutionCertificate();
      certificate.identity = { ...certificate.identity, assetId: "usdc-circle" };
      const reviewSec = Date.parse("2026-07-01T00:00:00Z") / 1000;
      certificate.observedAtSec = certificate.source.timestamp = reviewSec + (scenario === "older" || scenario === "noncanonical-older" ? -1 : 86400);
      const point = certificate.points[0]!;
      if (scenario === "diagnostic") { point.certification = "diagnostic"; point.reason = "execution-unavailable"; }
      const evidence = createV9EvidenceReference({
        evidenceId: "exact:route", sourceId: "exact:source", sourceGenerationId: "exact:generation", observedAtSec: certificate.observedAtSec,
        disposition: scenario === "rejected" ? "rejected" : "observed",
        ...(scenario === "rejected" ? { rejection: { code: "rejected", reason: "Rejected read", rejectedAtSec: fixed.clockSec } } : {}),
      }, fixed.clockSec);
      context.evidence.set(evidence.evidenceId, evidence);
      const route = {
        ...base, lane: "redemption" as const,
        routeId: scenario.startsWith("noncanonical") ? "execution:exact-request-digest" : "redemption:usdc-circle:offchain-issuer",
        executionCertificate: certificate, executionModelId: certificate.modelId,
        request: { requestedNotionalUsd: point.requestedNotionalUsd, maxCostBps: point.maxCostBps, settlementHorizonSec: 300 },
        status: { ...base.status, observationState: "known" as const, evidenceRefIds: [evidence.evidenceId] },
        factorStatuses: scenario === "stricter" ? { cost: { ...base.status, observationState: "unsupported" as const, gapIds: ["existing:rejected"] } } : {},
      };
      withRedemptionBackstopConfig("usdc-circle", { v9RouteReviewTerms: {
        scoringDisposition: "bounded-terms-gap", missingScoringFields: ["cost", "settlement", "capacity"], reviewedAt: "2026-07-01",
        rationale: "Exact bounds remain unknown.", docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["route"] }],
      } }, () => {
        const compiled = compileRouteFactorStatuses(context, route);
        expect(compiled.factorStatuses.cost!.observationState)
          .toBe(scenario === "stricter" ? "unsupported" : scenario === "newer" || scenario === "noncanonical-newer" ? "known" : "missing");
        if (scenario === "stricter") expect(compiled.factorStatuses.cost!.gapIds).toEqual(["existing:rejected"]);
      });
    },
  );
});

describe("Safety Score v9 exact base fact-set adapter — exit and DEX coverage", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  function reviewedWithCost(costBps: number) {
    const fixed = queuedRedemptionFixedInput(), reviewed = reviewedFor(fixed, { routeReviews: true });
    const rr = redemptionOf(reviewed.assets[0]!.routeReviews);
    rr.executionCosts = rr.executionCosts.map((point) => ({ ...point, executionCostBps: costBps }));
    return { fixed, reviewed };
  }
  function compileMissingPool(missingPool: boolean) {
    const draft = exactFixedInput(), cov = draft.dexLiqMap.alpha!.exitRouteObservationCoverage!;
    Object.assign(cov, {
      retainedPoolCount: 10_000, scoreEligibleCapabilityPoolCount: missingPool ? 2 : 1, scoreEligiblePoolCount: 1,
      unsupportedPoolCount: missingPool ? 9_999 : 9_998,
      unsupportedReasons: { "nonExecutableEvidence:discovery-pool-shaped": 9_998, ...(missingPool ? { "executionCapabilityGate:measured-execution:quote-failed": 1 } : {}) },
    });
    const fixed = rebuildFixed(draft);
    const factSet = compileFS(fixed, reviewedFor(fixed));
    return { factSet, asset: factSet.assets[0]! };
  }

  it.each([201])("re-admits a reviewed %s bps cost as zero within the request budget without quarantine", (costBps) => {
    const { fixed, reviewed } = reviewedWithCost(costBps);
    const compiled = compileIsolated(fixed, reviewed);
    expect(compiled.quarantines).toEqual([]);
    expect(redemptionOf(compiled.factSet.assets[0]!.exitRoutes).capacityCurve).toEqual([
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: costBps },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0, executionCostBps: costBps },
    ]);
    expect(capturedRedemption(fixed).executableUsd).toBe(1_000_000);
  });

  it.each([199, 200])("preserves executable capacity for a reviewed %s bps cost within the request budget", (costBps) => {
    const { fixed, reviewed } = reviewedWithCost(costBps);
    expect(redemptionOf(compileReviewedRoutes(fixed, reviewed)).capacityCurve).toEqual([
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 100_000, completionRatio: 1, executionCostBps: costBps },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, executionCostBps: costBps },
    ]);
  });

  it("retains the production curve when no reviewed cost overrides its realized costs", () => {
    const draft = structuredClone(queuedRedemptionFixedInput());
    const observation = capturedRedemption(draft);
    observation.capacityCurve = observation.capacityCurve!.map((point) => ({ ...point, executionCostBps: 7 }));
    const fixed = rebuildFixed(draft);
    expect(redemptionOf(compileReviewedRoutes(fixed)).capacityCurve).toEqual(observation.capacityCurve);
  });

  it.each([false, true])("retains unknown Exit beside unavailable redemption (empty DEX: %s)", (emptyDex) => {
    const fixed = structuredClone(queuedRedemptionFixedInput());
    Object.assign(fixed.redemptionBackstopMap.alpha!, {
      provider: "reserve-sync-metadata", resolutionState: "missing-capacity", capacityBasis: "live-direct-telemetry",
      capacityProfile: undefined, routeStatus: "open",
    });
    const dex = fixed.dexLiqMap.alpha!;
    if (emptyDex) {
      dex.exitRouteObservations = [];
      dex.exitRouteObservationCoverage = { ...dex.exitRouteObservationCoverage!, observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0, evidenceCounts: {} };
    } else for (const obs of dex.exitRouteObservations ?? []) {
      obs.executableUsd = 0; obs.completionRatio = 0;
      for (const point of obs.capacityCurve ?? []) { point.executableUsd = 0; point.completionRatio = 0; }
    }
    const rebuilt = rebuildFixed(fixed), isolated = compileIsolated(rebuilt, reviewedFor(rebuilt, { routeReviews: true }));
    expect(isolated.quarantines).toEqual([]);
    const asset = isolated.factSet.assets[0]!, missing = redemptionOf(asset.exitRoutes);
    expect(missing.status.observationState).toBe("missing");
    expect(missing.capacityCurve).toEqual([]);
    expect(missing.scoreEligible).toBe(false);
    expect(asset.gaps.find((gap) => missing.status.gapIds.includes(gap.gapId))!.causeProof).toMatchObject({ cause: "A", rejectionCode: "live-direct-capacity-unavailable" });
    const result = evalExitFor(asset, asset.exitRoutes, { circulatingUsd: 10_000_000, portfolioStatus: "incomplete" });
    expect(result.score).toBe(emptyDex ? 50 : null);
    expect(result.aggregationDisposition).toBe(emptyDex ? "included" : "excluded-a-b");
    if (emptyDex) expect(result.limitedEvidenceCauses).toContain("U");
    expect(result.routes.find((route) => route.routeKey === missing.routeKey)).toMatchObject({ score: null, included: false, capacityPoint: null });
  });

  it.each(["absent", "paused", "degraded", "resolved"] as const)("does not invent a missing-capacity diagnostic for %s redemption", (state) => {
    const fixed = structuredClone(queuedRedemptionFixedInput());
    Object.assign(fixed.redemptionBackstopMap.alpha!, {
      provider: "reserve-sync-metadata", resolutionState: state === "resolved" ? "resolved" : "missing-capacity",
      capacityBasis: "live-direct-telemetry", routeStatus: state === "paused" || state === "degraded" ? state : "open", capacityProfile: undefined,
    });
    if (state === "absent") {
      const base = exactFixedInput();
      fixed.redemptionBackstopMap = base.redemptionBackstopMap;
      fixed.redemptionGenerationId = base.redemptionGenerationId;
      fixed.redemptionStale = base.redemptionStale;
      fixed.inputFreshness.redemptionBackstops = base.inputFreshness.redemptionBackstops;
    }
    const rebuilt = rebuildFixed(fixed);
    expect(compileReviewedRoutes(rebuilt).some((route) => route.lane === "redemption")).toBe(false);
  });

  it("retains a parent-to-receipt conversion without scoring its capacity or inferring an empty exit census", () => {
    const registry = new Map([["strusd-tori", { variantKind: "savings-passthrough", variantOf: "alpha" }]]);
    const draft = structuredClone(exactFixedInput());
    const observation = capturedDex(draft);
    observation.output = { kind: "tracked-stablecoin", trackedAssetIds: ["strusd-tori"] };
    draft.navPriceById = { "strusd-tori": { priceUsd: 1.04, sourceId: "defillama-contract", observedAtSec: observation.observedAt, confidence: "high" } };
    const project = (relationships: typeof registry) => {
      const fixed = rebuildFixed(draft), extension = reviewedFor(fixed);
      extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha", relationships);
      return buildSafetyScoreV9Candidate({ fixedInput: fixed, extension, publishedAtSec: fixed.clockSec }).candidate.cards[0]!;
    };
    const card = project(registry);
    const exit = card.breakdowns!.exit;
    expect(exit.primaryRoute).toBeNull();
    expect(card.reasonCodes).not.toContain("no-viable-exit-path");
    expect(exit.alternatives).toContainEqual(expect.objectContaining({
      routeId: observation.routeId, label: expect.stringContaining("Conversion to strUSD"), score: null, included: false, capacity: null,
      payoutAssets: [{ key: "strusd-tori", symbol: "strUSD" }],
      conversion: { evidenceKind: observation.evidenceKind, inputCapacityUsd: 80_000, maxCostBps: 200 },
    }));
    const reverse = new Map([["alpha", { variantKind: "savings-passthrough", variantOf: "strusd-tori" }]]);
    const selected = project(reverse).breakdowns!.exit.primaryRoute;
    expect(selected).toMatchObject({ routeId: observation.routeId, capacity: {
      payoutAssets: [{ key: "strusd-tori", symbol: "strUSD" }], inputCapacityUsd: 400_000, maxCostBps: 200,
    } });
    observation.output = { kind: "unknown" };
    const unresolved = project(registry);
    expect(unresolved.breakdowns!.exit.primaryRoute).toBeNull();
    expect(unresolved.reasonCodes).not.toContain("no-viable-exit-path");
    expect(unresolved.breakdowns!.exit.alternatives).toContainEqual(expect.objectContaining({
      routeId: observation.routeId, payoutAssets: null, score: null, capacity: null,
    }));
    expect(isDexExitPayoutConversion("alpha", ["independent"], registry)).toBe(false);
    registry.set("nested", { variantKind: "pure-wrapper", variantOf: "strusd-tori" });
    expect(isDexExitPayoutConversion("alpha", ["nested"], registry)).toBe(true);
    registry.set("strusd-tori", { variantKind: "pure-wrapper", variantOf: "nested" });
    expect(isDexExitPayoutConversion("alpha", ["nested"], registry)).toBe(false);
  });

  it("canonicalizes fractional capacity points in ascending numeric order", () => {
    const fixed = structuredClone(exactFixedInput()), observation = capturedDex(fixed);
    observation.capacityCurve = [
      { requestedNotionalUsd: 2.5, maxCostBps: 10.25, executableUsd: 2.5, completionRatio: 1, executionCostBps: 10 },
      { requestedNotionalUsd: 10.5, maxCostBps: 9.5, executableUsd: 10.5, completionRatio: 1, executionCostBps: 9 },
    ];
    const dex = buildSafetyScoreV9RouteReviews(fixed, "alpha").find((r) => r.lane === "dex" && r.routeId === observation.routeId)!;
    expect(dex.executionCosts.map((point) => [point.maxCostBps, point.requestedNotionalUsd])).toEqual([[9.5, 10.5], [10.25, 2.5]]);
  });

  it("preserves live queued terms through the production review and fact boundary", () => {
    const fixed = queuedRedemptionFixedInput();
    const redemption = redemptionOf(compileReviewedRoutes(fixed));
    expect(redemption).toMatchObject({
      capacityScoringHorizon: "queued", settlementModel: "queued", settlementSlaSec: 30 * 86_400,
      queueDepthUsd: 1_500_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000, request: { settlementHorizonSec: 30 * 86_400 },
    });
    const exit = evaluateV9Exit({ circulatingUsd: 10_000_000, portfolioStatus: "reviewed-complete", routes: [projectV9ExitEvaluationRoute(redemption)] }, P);
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.primaryRouteKey).toBe(redemption.routeKey);
    expect(exit.routes[0]).toMatchObject({
      capacityScoringHorizon: "queued", settlementDelaySec: 30 * 86_400,
      capsApplied: expect.arrayContaining(["queue-backlog:0.65", "minimum-redeem:0.75"]),
    });
  });

  it("carries an unproven settlement bound from the queued observation into the route fact", () => {
    const fixed = queuedRedemptionFixedInput();
    capturedRedemption(fixed).settlementBoundUnproven = true;
    fixed.dexLiqMap.alpha = {
      ...fixed.dexLiqMap.alpha!, exitRouteObservations: [],
      exitRouteObservationCoverage: { ...fixed.dexLiqMap.alpha!.exitRouteObservationCoverage!, observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0, evidenceCounts: {} },
    };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const compiled = compileFS(fixed, reviewedFor(fixed, { routeReviews: true }));
    const redemption = redemptionOf(compiled.assets[0]!.exitRoutes);
    expect(redemption).toMatchObject({ settlementBoundUnproven: true, scoreEligible: false, settlementModel: "queued" });
    const evaluated = evaluateV9FactSet(compiled, P).assets[0]!;
    expect(evaluated.exit.score).toBeGreaterThan(0);
    expect(evaluated.exit.score).toBeLessThanOrEqual(70);
    const trace = evaluated.exit.routes.find((route) => route.routeKey === redemption.routeKey)!;
    expect(trace).toMatchObject({ included: true, components: { settlement: 50 } });
    expect(evaluated.exit.reasons).not.toContain("no-viable-exit-path");
    const settlementGapIds = redemption.factorStatuses!.settlement!.gapIds;
    expect(settlementGapIds).toHaveLength(1);
    expect(trace.factorContributions?.settlement).toMatchObject({ score: 50, causeGapIds: settlementGapIds, cause: "U", scoringDisposition: "bounded-uncertainty" });
  });

  it("withdraws producer eligibility when the v9 review has an unbounded settlement queue", () => {
    const fixed = queuedRedemptionFixedInput(300, true), reviewed = reviewedFor(fixed);
    reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "alpha").map((review) => ({
      ...review, settlementModel: "queued", settlementSlaSec: null, settlementHorizonSec: 30 * 86_400,
    }));
    expect(redemptionOf(compileReviewedRoutes(fixed, reviewed))).toMatchObject({
      settlementModel: "queued", settlementSlaSec: null, scoreEligible: false, request: { settlementHorizonSec: 30 * 86_400 },
    });
  });

  it("never shortens a captured route below the conservative reviewed settlement horizon", () => {
    const fixed = queuedRedemptionFixedInput(86_400);
    expect(redemptionOf(compileReviewedRoutes(fixed)).request?.settlementHorizonSec).toBe(30 * 86_400);
  });

  it("preserves reviewed capacity without inventing a quantified fee or admitting execution credit", () => {
    const fixed = boundedUnknownFeeRedemptionFixedInput({ clockSec: 86_400 });
    const compiled = compileFS(fixed, reviewedFor(fixed, { assetId: "usdc-circle", withClock: true, routeReviews: true, retained: true }));
    const redemption = redemptionOf(compiled.assets[0]!.exitRoutes);
    expect(redemption).toMatchObject({ feeEvidence: "undisclosed-reviewed", scoreEligible: false, status: { observationState: "known" } });
    expect(redemption.capacityCurve.every((point) => point.executableUsd > 0)).toBe(true);
    const exit = evalExitFor(compiled.assets[0]!, [redemption], { circulatingUsd: 10_000_000, portfolioStatus: "reviewed-complete" });
    expect(exit.score).toBeGreaterThan(0);
    expect(exit.routes[0]).toMatchObject({ included: true, rawSameNotionalCostBps: null, components: { cost: 50 } });
  });

  it("carries measured route history into v9 facts and evaluation traces", () => {
    const fixed = structuredClone(exactFixedInput()), observation = capturedDex(fixed);
    observation.evidenceKind = "measured-executable-depth";
    observation.observationHistory = {
      completeProducerCycleCount: 3, successfulObservationCount: 2, consecutiveSuccessCount: 0,
      observationWindowStartedAt: observation.observedAt - 200, observationWindowEndedAt: observation.observedAt,
      latestOperationalFailureAt: observation.observedAt, conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: observation.capacityCurve!,
    };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const reviewed = structuredClone(extension());
    reviewed.assets[0]!.routeReviews[0]!.modelConfidence = "high";
    const compiled = compileFS(fixed, reviewed);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({
      routeFamily: "dex-amm", modelConfidence: "high",
      observationHistory: { completeProducerCycleCount: 3, successfulObservationCount: 2, latestOperationalFailureAt: observation.observedAt, conservativeStatistic: "pointwise-minimum" },
    });
    const evaluated = evaluateV9FactSet(compiled, P).assets[0]!;
    expect(evaluated.exit.routes[0]).toMatchObject({
      routeFamily: "dex-amm", observationConfidence: "high", modelConfidence: "high",
      observationHistory: { successfulObservationCount: 2, latestOperationalFailureAt: observation.observedAt },
    });
    expect(evaluated.scoreInput.pillars.exit.evidenceLevel).toBe("strong");
    const immatureFixed = structuredClone(exactFixedInput());
    capturedDex(immatureFixed).evidenceKind = "measured-executable-depth";
    immatureFixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(immatureFixed);
    expect(evaluateV9FactSet(compileFS(immatureFixed, extension()), P).assets[0]!.scoreInput.pillars.exit.evidenceLevel).not.toBe("strong");
  });

  it.each(["exact-lower-bound", "exact-complete"] as const)(
    "retains R1 materiality semantics for small %s execution evidence",
    (coverageClass) => {
      const draft = structuredClone(exactFixedInput()), obs = capturedDex(draft);
      obs.executableUsd = 13; obs.completionRatio = 13 / obs.requestedNotionalUsd;
      obs.capacityCurve = obs.capacityCurve!.map((p) => ({ ...p, executableUsd: 13, completionRatio: 13 / p.requestedNotionalUsd }));
      const fixed = rebuildFixed(draft), reviewed = reviewedFor(fixed);
      reviewed.assets[0]!.routeReviews[0]!.coverageClass = coverageClass;
      const asset = compileFS(fixed, reviewed).assets[0]!, route = asset.exitRoutes[0]!;
      expect(asset.exitStatus).toMatchObject({ observationState: "known", gapIds: [] });
      expect(route).toMatchObject({ scoreEligible: true, coverageClass, status: { observationState: "known", gapIds: [] } });
      const result = evalExitFor(asset, [route], { portfolioStatus: "reviewed-complete" });
      expect(result.routes[0]).toMatchObject({
        included: false, score: coverageClass === "exact-complete" ? 0 : null,
        capacityPoint: { executableUsd: 13 }, capsApplied: ["immaterial-executable-capacity"], exclusionReason: "missing-same-notional-route",
      });
      expect(result.primaryRouteKey).toBeNull();
      expect(result.score).toBe(0);
      expect(result.reasons).toContain("no-viable-exit-path");
    },
  );

  it("joins route display names and supply IDs into one canonical chain common mode", () => {
    const template = exactFixedInput().chainCirculatingById.alpha!.ethereum!;
    const compiled = compileFS(exactFixedInput({ routeChain: "Monad", chainSupplyByChain: { monad: { ...template, current: 10_000_000 } } }), extension());
    const alpha = compiled.assets[0]!;
    expect(alpha.exitRoutes[0]!.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    expect(alpha.supply.failureDomains).toContainEqual({ kind: "chain", key: "monad" });
    const group = buildV9DependencyEvaluationPlan(compiled).commonModeGroups.find((c) => c.failureDomain.kind === "chain" && c.failureDomain.key === "monad");
    expect(group?.members).toEqual([{ assetId: "alpha", owner: "exit", pathKey: alpha.exitRoutes[0]!.routeKey }, { assetId: "alpha", owner: "supply", pathKey: "supply" }]);
  });

  it("attributes chain-contract redemption routes to a redemption rail, not a DEX protocol", () => {
    const fixed = queuedRedemptionFixedInput(), obs = capturedRedemption(fixed);
    obs.routeFamily = "protocol-redemption";
    obs.scope = { kind: "chain-contract", chain: "ethereum", contractOrPoolId: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51", protocol: "frax" };
    const reviewed = extension();
    reviewed.assets[0]!.routeReviews.push({ ...routeReview(obs.routeId), lane: "redemption", failureDomains: [] });
    const redemptionRoute = redemptionOf(compileReviewedRoutes(rebuildFixed(fixed), reviewed));
    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "chain", key: "ethereum" });
    expect(redemptionRoute.failureDomains).toContainEqual({ kind: "redemption-rail", key: "provider:ethereum:0x2397321b301b80a1c0911d6f9ed4b6033d43cf51" });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "redemption-rail", key: "frax" });
    expect(redemptionRoute.failureDomains).not.toContainEqual({ kind: "dex-protocol", key: "frax" });
  });

  it.each([
    ["different contracts", "ethereum", "0x2222222222222222222222222222222222222222", false],
    ["different chains", "base", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false],
    ["the same canonical endpoint", "Ethereum", "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", true],
  ] as const)("does not conflate a redemption model across %s", (_label, chain, contractOrPoolId, shared) => {
    const compileEndpoint = (endpointChain: string, endpoint: string) => {
      const fixed = queuedRedemptionFixedInput(), obs = capturedRedemption(fixed);
      obs.routeFamily = "protocol-redemption";
      obs.scope = { kind: "chain-contract", chain: endpointChain, contractOrPoolId: endpoint, protocol: "erc4626-instant" };
      const reviewed = extension();
      reviewed.assets[0]!.routeReviews.push({ ...routeReview(obs.routeId), lane: "redemption", failureDomains: [{ kind: "oracle-feed", key: "reviewed-shared-oracle" }] });
      return compileFS(rebuildFixed(fixed), reviewed).assets[0]!;
    };
    const alpha = compileEndpoint("ethereum", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const beta = { ...compileEndpoint(chain, contractOrPoolId), assetId: "beta" };
    const plan = buildV9DependencyEvaluationPlan({ activeAssetIds: ["alpha", "beta"], assets: [alpha, beta] });
    const rails = plan.commonModeGroups.filter((group) => group.failureDomain.kind === "redemption-rail");
    expect(rails.some((group) => group.failureDomain.key === "erc4626-instant")).toBe(false);
    expect(rails.some((g) => g.failureDomain.key === "provider:ethereum:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" && new Set(g.members.map((m) => m.assetId)).size === 2)).toBe(shared);
    expect(plan.commonModeGroups).toContainEqual(expect.objectContaining({
      failureDomain: { kind: "oracle-feed", key: "reviewed-shared-oracle" },
      members: expect.arrayContaining([expect.objectContaining({ assetId: "alpha", owner: "exit" }), expect.objectContaining({ assetId: "beta", owner: "exit" })]),
    }));
    expect(alpha.exitRoutes.filter((r) => r.lane === "dex").flatMap((r) => r.failureDomains)).toContainEqual({ kind: "dex-protocol", key: "fixture-dex" });
  });

  it("keeps shaped diagnostic pools out of the DEX completeness denominator without hiding exact gates", () => {
    const fixedWithCoverage = (exactCapabilityPoolCount: number, extraGate?: Record<string, number>) => {
      const original = exactFixedInput();
      return rebuildFixed({
        ...original,
        dexLiqMap: { alpha: { ...original.dexLiqMap.alpha!, exitRouteObservationCoverage: emptyDexCov({
          retainedPoolCount: 2_380 + exactCapabilityPoolCount, observationCount: 1, scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1, scoreEligibleCapabilityPoolCount: exactCapabilityPoolCount, unsupportedPoolCount: 2_379 + exactCapabilityPoolCount,
          evidenceCounts: { "reserve-based-amm-simulation": 1 },
          unsupportedReasons: {
            "nonExecutableEvidence:defillama-pool-shaped": 1_449, "nonExecutableEvidence:curve-stableswap-shaped": 11,
            "nonExecutableEvidence:direct-api-amm-shaped": 653, "nonExecutableEvidence:discovery-pool-shaped": 267,
            ...(extraGate ?? (exactCapabilityPoolCount > 1 ? { "executionCapabilityGate:measured-execution:quote-failed": 1 } : {})),
          },
        }) } },
      });
    };
    const complete = compileFS(fixedWithCoverage(1), extension()).assets[0]!;
    expect(complete.exitStatus.observationState).toBe("known");
    expect(complete.gaps.map((g) => g.reasonCode)).not.toContain("incomplete-dex-route-coverage");
    const gated = compileFS(fixedWithCoverage(2), extension()).assets[0]!;
    expect(gated.exitStatus.observationState).toBe("bounded-unknown");
    expect(gated.gaps.map((g) => g.reasonCode)).toContain("incomplete-dex-route-coverage");
    const unresolved = compileFS(fixedWithCoverage(1, { "fluid-swap-state-missing": 1 }), extension()).assets[0]!;
    expect(unresolved.exitStatus.observationState).toBe("bounded-unknown");
    const modelLimitOnly = compileFS(fixedWithCoverage(2, { "executionCapabilityGate:curve-stableswap:rate-bearing-inputs": 1 }), extension()).assets[0]!;
    expect(modelLimitOnly.exitStatus.observationState).toBe("known");
    expect(modelLimitOnly.gaps.map((g) => g.reasonCode)).not.toContain("incomplete-dex-route-coverage");
  });

  it("does not infer an immaterial missing DEX remainder from pool counts or supply materiality", () => {
    const complete = compileMissingPool(false), missing = compileMissingPool(true);
    const completeEval = evalExitFor(complete.asset), missingEval = evalExitFor(missing.asset);
    const gapId = "alpha:gap:exit-portfolio-coverage";
    expect(complete.asset.gaps.map((gap) => gap.gapId)).not.toContain(gapId);
    expect(missing.asset.gaps.find((gap) => gap.gapId === gapId)).toMatchObject({ reasonCode: "incomplete-dex-route-coverage", causeProof: { cause: "U" } });
    expect(missing.asset.exitStatus.observationState).toBe("bounded-unknown");
    expect(missingEval.causeGapIds).toContain(gapId);
    expect(missing.asset.exitRoutes).toEqual(complete.asset.exitRoutes);
    expect(missingEval.routes.map((r) => r.capacityPoint)).toEqual(completeEval.routes.map((r) => r.capacityPoint));
  });

  it("keeps the DEX coverage label documentation without making it an Exit witness", () => {
    const complete = compileMissingPool(false), missing = compileMissingPool(true);
    const completeEval = evaluateV9FactSet(complete.factSet, P).assets[0]!, missingEval = evaluateV9FactSet(missing.factSet, P).assets[0]!;
    const gapId = "alpha:gap:exit-portfolio-coverage";
    expect(classifyV9DocumentationGap(P, missing.asset, missing.asset.gaps.find((c) => c.gapId === gapId)!)?.reason).toBe("coverage-label");
    expect(missingEval.exit.causeGapIds).toContain(gapId);
    for (const evaluated of [completeEval, missingEval]) {
      for (const pillar of ["backing", "exit", "control"] as const) {
        expect(evaluated.scoreInput.pillars[pillar].limitingCauseGapIds ?? []).not.toContain(gapId);
      }
    }
    expect(missingEval.scoreInput.pillars.exit.score).toBe(completeEval.scoreInput.pillars.exit.score);
    expect(missingEval.trace.finalScore).toBe(completeEval.trace.finalScore);
  });

  it("keeps the DEX portfolio denominator and cause independent of fee-only changes", () => {
    const assetId = "usdc-circle";
    const run = (costModel: RedemptionBackstopConfig["costModel"], observedPools: number) => {
      const draft = exactFixedInput({ assetId, clockSec: Date.UTC(2026, 6, 13) / 1_000 });
      draft.redemptionBackstopMap = {};
      attachRedemption(draft, assetId, makeSupplyFullRedemption({ stablecoinId: assetId, feeBps: null, updatedAt: draft.clockSec }), "redemption:fee-only-fixture");
      const coverage = draft.dexLiqMap[assetId]!.exitRouteObservationCoverage!;
      if (observedPools === 2) {
        draft.dexLiqMap[assetId]!.exitRouteObservations!.push(v9ExitRouteObservation("dex:secondary", draft.clockSec - 100, "ethereum", draft.clockSec, "dex:secondary"));
      }
      Object.assign(coverage, {
        observationCount: observedPools, scoreEligibleObservationCount: observedPools, evidenceCounts: { "reserve-based-amm-simulation": observedPools },
        retainedPoolCount: 2, scoreEligibleCapabilityPoolCount: 2, scoreEligiblePoolCount: observedPools, unsupportedPoolCount: 2 - observedPools,
        unsupportedReasons: observedPools === 1 ? { "executionCapabilityGate:measured-execution:quote-failed": 1 } : {},
      });
      const fixed = rebuildFixed(draft);
      return withRedemptionBackstopConfig(assetId, { costModel, v9RouteCostTerms: undefined, v9RouteReviewTerms: undefined }, () => {
        const compiled = compileFS(fixed, reviewedFor(fixed, { assetId, withClock: true, routeReviews: true, retained: true }));
        const asset = compiled.assets[0]!;
        return {
          causeGapIds: evaluateV9FactSet(compiled, P).assets[0]!.exit.causeGapIds,
          portfolioGap: asset.gaps.find((gap) => gap.gapId === `${assetId}:gap:exit-portfolio-coverage`),
          redemption: redemptionOf(asset.exitRoutes),
        };
      });
    };
    const unknownFee: RedemptionBackstopConfig["costModel"] = { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" };
    for (const observedPools of [1, 2]) {
      const before = run(unknownFee, observedPools), after = run(fixedFee(0), observedPools);
      expect(before.redemption.factorStatuses.cost!.observationState).toBe("missing");
      expect(before.causeGapIds).toEqual(expect.arrayContaining(before.redemption.factorStatuses.cost!.gapIds));
      expect(after.redemption.capacityCurve.every((point) => point.executionCostBps === 0)).toBe(true);
      expect(after.redemption.factorStatuses.cost!.observationState).toBe("known");
      for (const gapId of before.redemption.factorStatuses.cost!.gapIds) expect(after.causeGapIds).not.toContain(gapId);
      expect(after.portfolioGap).toEqual(before.portfolioGap);
      if (observedPools === 1) {
        expect(after.portfolioGap?.reasonCode).toBe("incomplete-dex-route-coverage");
        expect(before.causeGapIds).toContain(`${assetId}:gap:exit-portfolio-coverage`);
        expect(after.causeGapIds).toContain(`${assetId}:gap:exit-portfolio-coverage`);
      } else {
        expect(after.portfolioGap).toBeUndefined();
        expect(before.causeGapIds).not.toContain(`${assetId}:gap:exit-portfolio-coverage`);
        expect(after.causeGapIds).not.toContain(`${assetId}:gap:exit-portfolio-coverage`);
      }
    }
  });

  it.each([
    "deploymentCensusUnsupportedMethod", "deploymentCensusProviderOutage", "deploymentCensusNonExhaustiveProvider",
    "nonExecutableEvidence:defillama-pool-shaped", "executionCapabilityGate:curve-stableswap:rate-bearing-inputs",
    "executionCapabilityGate:measured-execution:target-unresolved", "fluid-pool-identity-unverified",
  ])("does not upgrade the legacy %s coverage counter into pipeline proof", (unsupportedReason) => {
    for (const withRedemptionRoute of [false, true]) {
      const original = withRedemptionRoute ? queuedRedemptionFixedInput() : exactFixedInput();
      const census = unsupportedReason.startsWith("deploymentCensus");
      const fixed = rebuildFixed({
        ...original,
        dexLiqMap: { alpha: { ...original.dexLiqMap.alpha!, exitRouteObservations: [], exitRouteObservationCoverage: emptyDexCov({
          ...original.dexLiqMap.alpha!.exitRouteObservationCoverage!, status: census ? "unknown" : "unsupported",
          retainedPoolCount: census ? 0 : 4, observationCount: 0, scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0,
          scoreEligibleCapabilityPoolCount: 0, unsupportedPoolCount: census ? 0 : 4, evidenceCounts: {}, unsupportedReasons: { [unsupportedReason]: 1 },
        }) } },
      });
      const reviewed = extension(); reviewed.assets[0]!.routeReviews = [];
      const factSet = compileFS(fixed, reviewed), asset = factSet.assets[0]!;
      const gap = asset.gaps.find((e) => e.gapId === (withRedemptionRoute ? "alpha:gap:exit-portfolio-coverage" : "alpha:gap:exit-routes"));
      expect(gap).toMatchObject({ causeProof: { cause: "U" } });
      if (unsupportedReason === "fluid-pool-identity-unverified") expect(gap!.message).toContain("Fluid swap state is unresolved");
      expect(buildV9EvidenceGapQueue({ factSet, policy: P }).summary.policyBindingMismatchGapCount).toBe(0);
      expect(evalExitFor(asset).aggregationDisposition).toBe("included");
    }
  });
});

describe("cause-bound Exit compiler admission", () => {
  it.each([
    { evidenceKind: "measured-executable-depth" as const, tier: "live-direct" as const },
    { evidenceKind: "direct-orderbook-depth" as const, tier: "live-direct" as const },
    { evidenceKind: "reserve-based-amm-simulation" as const, tier: "heuristic" as const },
  ])("retains established fresh $evidenceKind capacity without a missing-method discount", ({ evidenceKind, tier }) => {
    const draft = structuredClone(exactFixedInput()), obs = capturedDex(draft);
    Object.assign(obs, { evidenceKind, capacityEvidenceTier: "unknown", observedAt: draft.clockSec });
    if (evidenceKind === "direct-orderbook-depth") obs.routeFamily = "dex-orderbook";
    const fixed = rebuildFixed(draft), reviewed = reviewedFor(fixed);
    for (const route of reviewed.assets[0]!.routeReviews) route.modelConfidence = "high";
    const asset = compileFS(fixed, reviewed).assets[0]!;
    expect(evalExitFor(asset, [asset.exitRoutes.find((r) => r.lane === "dex")!]).routes[0]).toMatchObject({
      included: true, capacityEvidenceTier: tier, confidenceFactor: 1,
      confidenceDimensions: { capacityMethod: { factor: 1, cause: null, causeGapIds: [] } },
    });
  });

  it("does not let a recognized measured method revive stale DEX capacity", () => {
    const draft = structuredClone(exactFixedInput({ clockSec: 20_000 }));
    Object.assign(capturedDex(draft), { evidenceKind: "measured-executable-depth", observedAt: 1 });
    const fixed = rebuildFixed(draft), asset = compileFS(fixed, reviewedFor(fixed, { withClock: true })).assets[0]!;
    expect(evalExitFor(asset, [asset.exitRoutes.find((r) => r.lane === "dex")!]).routes[0]).toMatchObject({
      included: false, score: null, capacityPoint: null, exclusionReason: "missing-runtime-route-evidence",
    });
  });

  it.each([true, false])("retains queue/proxy confidence with an explicit tier: %s", (explicitTier) => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, false)), row = draft.redemptionBackstopMap.alpha!;
    row.capacityKind = "live-queue";
    const obs = row.capacityProfile!.exitRouteObservations![0]!;
    if (explicitTier) obs.capacityEvidenceTier = "live-queue-proxy";
    else delete obs.capacityEvidenceTier;
    const fixed = rebuildFixed(draft), asset = compileFS(fixed, reviewedFor(fixed, { routeReviews: true })).assets[0]!;
    const route = redemptionOf(asset.exitRoutes), result = evalExitFor(asset, [route]);
    expect(result.routes[0]!.confidenceDimensions).toMatchObject({ observation: { factor: 1 }, model: { factor: 1 }, capacityMethod: { factor: 0.75 } });
    expect(result.routes[0]).toMatchObject({ capacityEvidenceTier: "live-queue-proxy", queueDepthUsd: 1_500_000, dailyLimitUsd: 1_000_000, minRedeemUsd: 1_000_000 });
    expect(route.settlementModel).toBe("queued");
    expect(route.scoreEligible).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });

  it("retains a stale captured observation as diagnostic A rather than executable current capacity", () => {
    const draft = structuredClone(queuedRedemptionFixedInput(300, true));
    capturedRedemption(draft).observedAt = draft.clockSec - 501;
    const fixed = rebuildFixed(draft), asset = compileFS(fixed, reviewedFor(fixed, { routeReviews: true })).assets[0]!;
    const route = redemptionOf(asset.exitRoutes);
    expect(asset.gaps.find((gap) => route.status.gapIds.includes(gap.gapId))!.causeProof).toMatchObject({ cause: "A", sourceGenerationId: fixed.redemptionGenerationId });
    const result = evalExitFor(asset, [route]);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", limitedEvidenceCauses: [] });
    expect(result.routes[0]).toMatchObject({ score: null, included: false, capacityPoint: null });
  });

  it("rejects the entire 65-route reader inventory with scoped A proof and retains the last diagnostic", () => {
    const queue = queuedRedemptionFixedInput(300, true), obs = capturedRedemption(queue);
    const redemptionReview = redemptionOf(buildSafetyScoreV9RouteReviews(queue, "alpha"));
    const fixed = exactFixedInput(), reviewed = reviewedFor(fixed);
    const limit = P.policy.semantic.exit.maximumScoreEligiblePortfolioCandidates;
    const retained = Array.from({ length: limit + 1 }, (_, i) => ({
      lane: "redemption" as const, observation: { ...structuredClone(obs), routeId: `redemption:alpha:${String(i).padStart(2, "0")}` },
      disposition: "observed" as const, rejection: null,
    }));
    reviewed.assets[0]!.retainedRoutes = retained;
    reviewed.assets[0]!.routeReviews = [...reviewed.assets[0]!.routeReviews, ...retained.map((r) => ({ ...structuredClone(redemptionReview), routeId: r.observation.routeId }))];
    const asset = compileFS(fixed, reviewed).assets[0]!;
    const overflow = asset.gaps.find((g) => g.causeProof.cause === "A" && g.causeProof.rejectionCode === "route-inventory-over-limit")!;
    expect(overflow.causeScope).toMatchObject({ pillar: "exit", componentKey: "exit-routes", requiredDatum: "route-inventory" });
    expect(overflow.causeProof).toMatchObject({ cause: "A", producerState: "unsupported-reader", sourceGenerationId: fixed.sourceGeneration });
    const result = evalExitFor(asset);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b", primaryRouteKey: null, diversificationRouteKey: null, supportedComponentKeys: [] });
    const last = asset.exitRoutes.find((r) => r.routeId === `redemption:alpha:${String(limit).padStart(2, "0")}`)!;
    expect(result.routes.find((r) => r.routeKey === last.routeKey)).toMatchObject({ score: null, included: false, capacityPoint: null, cause: "A", effectiveScoringWeight: 0 });
  });
});

describe("rejected-source route factor exclusion", () => {
  it.each([false, true])("keeps rejected runtime factors non-known with a reviewed route: %s", (withReview) => {
    const queue = queuedRedemptionFixedInput(300, true);
    const obs = structuredClone(capturedRedemption(queue));
    obs.routeId = "redemption:alpha:rejected"; obs.capacityEvidenceTier = "live-direct";
    const fixed = exactFixedInput(), reviewed = reviewedFor(fixed);
    reviewed.assets[0]!.retainedRoutes = [{ lane: "redemption", observation: obs, disposition: "rejected",
      rejection: { code: "captured-reader-rejected", reason: "The captured producer rejected this route.", rejectedAtSec: fixed.clockSec } }];
    if (withReview) {
      reviewed.assets[0]!.routeReviews.push({ ...redemptionOf(buildSafetyScoreV9RouteReviews(queue, "alpha")), routeId: obs.routeId });
    }
    const compiled = compileIsolated(fixed, reviewed);
    expect(compiled.quarantines).toEqual([]);
    const asset = compiled.factSet.assets[0]!, route = asset.exitRoutes.find((r) => r.routeId === obs.routeId)!;
    for (const factorKey of ["capacity", "observationConfidence", "cost", "capacityEvidenceTier"] as const) {
      const status = route.factorStatuses[factorKey]!;
      expect(status.observationState).not.toBe("known");
      const gap = asset.gaps.find((gap) => status.gapIds.includes(gap.gapId))!;
      expect(gap.causeProof).toMatchObject({ cause: "A", rejectionCode: "captured-reader-rejected" });
      expect(gap.causeScope).toMatchObject({ routeKey: route.routeKey, factorKey, requiredDatum: factorKey });
    }
    const result = evalExitFor(asset, [route]);
    expect(result).toMatchObject({ score: null, aggregationDisposition: "excluded-a-b" });
    expect(result.routes[0]).toMatchObject({ included: false, capacityPoint: null });
  });
});

describe("compiled Control causal minimum regressions", () => {
  it.each([
    { reconciliation: "internal-ledger" as const, cap: "unbounded" as const, supervision: "none" as const, missingWholeSupply: true },
    { reconciliation: "continuous" as const, cap: "unbounded" as const, supervision: "none" as const, missingWholeSupply: false },
    { reconciliation: "internal-ledger" as const, cap: "bounded" as const, supervision: "none" as const, missingWholeSupply: false },
    { reconciliation: "internal-ledger" as const, cap: "unbounded" as const, supervision: "prudential" as const, missingWholeSupply: false },
  ])("scopes whole-supply absence only to $reconciliation/$cap/$supervision", ({ reconciliation, cap, supervision, missingWholeSupply }) => {
    const fixed = exactFixedInput(), reviewed = reviewedFor(fixed), overlay = reviewed.assets[0]!;
    overlay.controlReview = { state: "reviewed-controls", controls: [{
      controlKey: "mint:issuer", deploymentKey: "ethereum:issuer", controlKind: "mint", scope: "global",
      capabilities: ["mint"], capSemantics: { kind: cap, bound: cap === "bounded" ? { amount: 0.1, unit: "supply-fraction" } : null },
      claimImpairment: cap, economicLossScope: "global-claim", authority: { authorityKey: "ethereum:issuer", model: "eoa", threshold: null },
      delaySec: null, materialSupplyShare: null, keyCustody: "unknown", modulesOrGuards: "unknown",
      incidentState: "none", failureDomains: [{ kind: "mint-control", key: "ethereum:issuer" }],
    }] };
    overlay.economicControlReview!.mint = {
      status: v9Status("known", "v9.control.mint-review"), controlKey: "mint:issuer", reconciliation, supervision,
      latestResolvedIncidentAtSec: null, upgrade: { state: "not-applicable", controlKey: null },
    };
    const compiled = compileIsolated(fixed, reviewed);
    expect(compiled.quarantines).toEqual([]);
    const asset = compiled.factSet.assets[0]!;
    const result = evaluateV9EconomicControl({ facts: asset, ...asset.economicControlReview, policy: P });
    const mint = result.components.find((c) => c.kind === "mint")!;
    if (missingWholeSupply) {
      const status = asset.economicControlReview.mint.factorStatuses!.reconciliation!;
      expect(status.observationState).not.toBe("known");
      const gap = asset.gaps.find((g) => status.gapIds.includes(g.gapId))!;
      expect(gap.causeScope).toMatchObject({ pillar: "control", componentKey: "economic-control:mint", factorKey: "reconciliation", requiredDatum: "reconciliation" });
      expect(mint).toMatchObject({ score: 50, cause: "U", causeGapIds: [gap.gapId], scoringDisposition: "bounded-uncertainty" });
    } else {
      expect(mint).toMatchObject({ cause: null, scoringDisposition: "included" });
    }
    expect(result.score).toBe(Math.min(...result.components.filter((c) => c.binding && c.score !== null).map((c) => c.score!)));
  });
});

describe("direct exit fact builder", () => {

  it("reports absent exit observations as missing, not a known zero-exit market", () => {
    const fixed = exactFixedInput({ includeDexObservations: false, includeDexCoverage: false });
    const reviewed = reviewedFor(fixed);
    reviewed.assets[0]!.routeReviews = [];
    const ctx = factBuilderContext(fixed, reviewed);
    const res = buildRoutes(ctx, buildSupply(ctx));
    expect(res.exitRoutes).toEqual([]);
    expect(res.exitStatus.observationState).toBe("missing");
    expect([...ctx.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "missing-runtime-route-evidence", observationState: "missing" }));
  });

  it("rejects a review for an observation that was not captured", () => {
    const fixed = exactFixedInput();
    const reviewed = reviewedFor(fixed);
    reviewed.assets[0]!.routeReviews.push(routeReview("dex:absent"));
    const ctx = factBuilderContext(fixed, reviewed);
    expect(() => buildRoutes(ctx, buildSupply(ctx))).toThrow(/Route reviews do not match captured observations/);
  });

  it("compiles priorVerifiedEmptyExitCeiling on unavailable DEX coverage, prevents score jump, expires after 48h, and clears on positive route (v10.50)", () => {
    const t0 = Date.parse("2026-10-20T12:00:00Z") / 1_000;
    const run = (clockSec: number, status: "populated" | "unknown", acceptedPublication?: ReturnType<typeof buildSafetyScoreV9AcceptedPublicationBaseline>) => {
      const d = exactFixedInput({ clockSec });
      d.dexLiqMap.alpha!.exitRouteObservations = [];
      d.dexLiqMap.alpha!.exitRouteObservationCoverage = {
        status, capabilityMatrixVersion: DEX_ROUTE_CAPABILITY_MATRIX_VERSION, retainedPoolCount: 0, observationCount: 0,
        scoreEligibleObservationCount: 0, scoreEligiblePoolCount: 0, scoreEligibleCapabilityPoolCount: 0, unsupportedPoolCount: 0,
        evidenceCounts: {}, unsupportedReasons: status === "populated" ? {} : { deploymentCensusUnavailable: 1 },
      };
      if (status === "populated") {
        d.dexDeploymentSupplyCoverageById.alpha = {
          totalSupplyUsd: 10_000_000, verifiedNoPoolsSupplyUsd: 10_000_000, verifiedNoPoolsSupplyRatio: 1, observedSupplyUsd: 0,
          observedSupplyRatio: 0, providerInaccessibleSupplyUsd: 0, providerInaccessibleSupplyRatio: 0, unknownSupplyUsd: 0, unknownSupplyRatio: 0, unknownChains: [],
        };
      } else delete d.dexDeploymentSupplyCoverageById.alpha;
      const fixed = rebuildFixed(d);
      const rev = structuredClone(extension({ clockSec, registryFingerprint: fixed.registryFingerprint }));
      rev.assets[0]!.routeReviews = [];
      return buildSafetyScoreV9Candidate({ fixedInput: fixed, extension: rev, publishedAtSec: clockSec, acceptedPublication });
    };
    const cardOf = (p: ReturnType<typeof buildSafetyScoreV9Candidate>) => p.candidate.cards.find((c) => c.id === "alpha")!;
    const factsOf = (p: ReturnType<typeof buildSafetyScoreV9Candidate>) => p.compiledFacts.assets.find((a) => a.assetId === "alpha")!;

    const base = run(t0, "populated");
    const baseCard = cardOf(base);
    expect(baseCard.pillars.exit.score).toBe(0);
    expect(baseCard.pillars.exit.reasons).toContainEqual(expect.objectContaining({ code: "no-viable-exit-path", cause: "D" }));
    const emptyScore = baseCard.score!;
    const accepted = buildSafetyScoreV9AcceptedPublicationBaseline(base.candidate);
    expect(accepted.verifiedEmptyExitByAssetId?.alpha).toEqual({
      verifiedAtSec: t0, dexGenerationId: base.candidate.sourceGenerations.dex, publicationGenerationId: base.candidate.publicationGenerationId,
    });
    const t1 = t0 + 3_600;
    expect(cardOf(run(t1, "unknown")).score!).toBeGreaterThan(emptyScore);
    const capped = run(t1, "unknown", accepted);
    const cappedFacts = factsOf(capped);
    const cappedCard = cardOf(capped);
    expect(cappedFacts.priorVerifiedEmptyExitCeiling).toEqual({ scoreCeiling: 0, verifiedAtSec: t0, sourceGenerationId: base.candidate.sourceGenerations.dex, maxAgeSec: 172_800 });
    expect(cappedFacts.exitStatus.observationState).toBe("missing");
    expect(cappedFacts.gaps).toContainEqual(expect.objectContaining({
      reasonCode: "missing-runtime-route-evidence", observationState: "missing", message: "No exact DEX, redemption, or retained route observation is available.",
    }));
    expect(cappedCard.score).toBe(emptyScore);
    expect(cappedCard.pillars.exit.reasons.some((r) => r.code === "no-viable-exit-path")).toBe(false);
    expect(cappedCard.scoreTrace.aggregation?.pricedUnknownPillars).toContainEqual(expect.objectContaining({ pillar: "exit", score: 0 }));
    const expired = run(t0 + 172_801, "unknown", accepted);
    expect(factsOf(expired).priorVerifiedEmptyExitCeiling).toBeUndefined();
    expect(cardOf(expired).score!).toBeGreaterThan(emptyScore);
    const posFixed = exactFixedInput({ clockSec: t1 });
    const recovered = buildSafetyScoreV9Candidate({
      fixedInput: posFixed, extension: extension({ clockSec: t1, registryFingerprint: posFixed.registryFingerprint }), publishedAtSec: t1, acceptedPublication: accepted,
    });
    expect(recovered.compiledFacts.assets[0]!.priorVerifiedEmptyExitCeiling).toBeUndefined();
    expect(buildSafetyScoreV9AcceptedPublicationBaseline(recovered.candidate, {}, { priorVerifiedEmptyExitByAssetId: accepted.verifiedEmptyExitByAssetId }).verifiedEmptyExitByAssetId).toBeUndefined();
  });

  it("marks physical-commodity-delivery USD capacity not-applicable without affecting non-physical routes", () => {
    const fixed = exactFixedInput({ clockSec: 1_800_000_000, includeDexObservations: false, includeDexCoverage: false });
    const t = fixed.clockSec;
    const mkVal = (basis: "commodity-delivery" | "reviewed-par", refKey: string, unit: number, src: string) => ({
      basis, referenceAssetKey: refKey, unitValueUsd: unit, expectedUnitValueUsd: unit, sourceId: src,
      sourceGenerationId: `${src}:gen`, observedAtSec: t, confidence: "high" as const, maxAgeSec: 86_400, url: null, contentSha256: null,
    });
    const rid = "redemption:alpha:offchain-issuer";
    fixed.redemptionBackstopMap.alpha = {
      ...makeSupplyFullRedemption({ stablecoinId: "alpha", updatedAt: t, outputAssetType: "physical-commodity-delivery" }),
      capacityProfile: {
        immediateUsd: null, scoringUsd: 10_000_000, scoringHorizon: "eventual", capacityProfileConfidence: "documented-bound", modeledExitSizeUsd: 1_000_000,
        exitRouteObservations: [{
          routeId: rid, routeFamily: "eventual-redemption", scope: { kind: "issuer", issuerId: "alpha" },
          requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1, settlementHorizonSec: 14 * 86_400,
          output: { kind: "physical-commodity-delivery", assetKeys: ["commodity:xau"], sameNotionalEligible: false },
          evidenceKind: "documented-terms", confidence: "low", scoreEligible: false, observedAt: t, freshnessSeconds: 0, commonModeKeys: ["issuer:alpha"],
        }],
      },
    };
    fixed.redemptionGenerationId = "redemption:phys-na";
    fixed.redemptionStale = false;
    fixed.inputFreshness.redemptionBackstops = { updatedAt: t, ageSeconds: 0, stale: false };
    const baseRev = reviewedFor(fixed, { withClock: true });
    baseRev.assets[0]!.routeReviews = [{
      lane: "redemption", routeId: rid, holderAccess: "institutional-eligible", executionModel: "discretionary",
      executionCertainty: "conditional", modelConfidence: "low", coverageClass: "diagnostic", capacityScoringHorizon: "eventual",
      settlementModel: "bounded-delay", settlementSlaSec: null, settlementHorizonSec: 14 * 86_400, queueDepthUsd: null, dailyLimitUsd: null, minRedeemUsd: null,
      executionCosts: [{ requestedNotionalUsd: 1_000_000, maxCostBps: 200, executionCostBps: 200 }], physicalResourceKeys: ["issuer:alpha"], failureDomains: [],
      output: { kind: "physical-commodity-delivery", sameNotionalEligible: false, assetKeys: ["commodity:xau"], basketWeights: [], valuation: mkVal("commodity-delivery", "commodity:xau", 2_500, "commodity-ref") },
    }];
    const runV = (mutF?: (d: typeof fixed) => void, mutR?: (r: typeof baseRev) => void) => {
      const f = structuredClone(fixed); mutF?.(f);
      const rebuilt = rebuildFixed(f);
      const rev = structuredClone(baseRev); rev.registryFingerprint = rebuilt.registryFingerprint; mutR?.(rev);
      const ctx = factBuilderContext(rebuilt, rev);
      expect(ctx.asset.admissionQuarantine).toBeUndefined();
      return { ctx, res: buildRoutes(ctx, buildSupply(ctx)) };
    };
    const naCap = { observationState: "known", gapIds: [], applicability: { state: "not-applicable", policyRuleId: "v9.exit.physical-delivery-capacity", gapId: null } };
    const { ctx: physCtx, res: phys } = runV();
    expect(phys.exitRoutes).toHaveLength(1);
    expect(phys.exitRoutes[0]).toMatchObject({ scoreEligible: false, capacityCurve: [], request: null, status: naCap, factorStatuses: { capacity: naCap } });
    expect([...physCtx.gaps.keys()].some((id) => id.endsWith(":capacity"))).toBe(false);
    expect(phys.exitStatus.gapIds.some((id) => id.endsWith(":capacity"))).toBe(false);
    const compiledPhys = compileRouteFactorStatuses(physCtx, phys.exitRoutes[0]!);
    expect(compiledPhys.factorStatuses.capacity).toMatchObject(naCap);
    for (const k of ["access", "holderEligibility", "executionConfidence", "observationConfidence", "capacityEvidenceTier", "output"] as const) {
      expect(compiledPhys.factorStatuses[k]).toMatchObject({ observationState: "known", applicability: { state: "required", policyRuleId: "v9.exit.route-factors" } });
    }
    const { ctx: staleCtx, res: stale } = runV((d) => {
      const obs = capturedRedemption(d);
      obs.observedAt = t - 400 * 86_400; obs.freshnessSeconds = 400 * 86_400;
    });
    const staleRoute = stale.exitRoutes[0]!;
    expect(staleRoute).toMatchObject({
      scoreEligible: false, capacityCurve: [], request: null,
      status: { observationState: "missing", applicability: { state: "required", policyRuleId: "v9.exit.same-notional-route" } },
      factorStatuses: { capacity: naCap },
    });
    const staleGap = staleCtx.gaps.get(staleRoute.status.gapIds[0]!)!;
    expect(staleGap).toMatchObject({ observationState: "missing", causeProof: { cause: "A", rejectionCode: "route-observation-stale" } });
    expect(staleGap.causeProof.evidenceRefIds.some((id) => staleCtx.evidence.has(id))).toBe(true);
    expect(stale.exitStatus.gapIds.some((id) => id.endsWith(":capacity"))).toBe(false);
    for (const [outputAssetType, obsOut, revOut] of [
      ["stable-single", { kind: "fiat", currency: "USD", assetKeys: ["fiat:USD"] },
        { kind: "fiat", assetKeys: ["fiat:USD"], basketWeights: [], valuation: mkVal("reviewed-par", "fiat:USD", 1, "fiat-ref") }],
      ["mixed-collateral", { kind: "unresolved-basket", assetKeys: ["usdc-circle", "usdt-tether"] },
        { kind: "basket", assetKeys: ["usdc-circle", "usdt-tether"], basketWeights: [{ assetKey: "usdc-circle", weight: 0.5 }, { assetKey: "usdt-tether", weight: 0.5 }], valuation: null }],
    ] as const) {
      const { res } = runV((d) => {
        d.redemptionBackstopMap.alpha!.outputAssetType = outputAssetType;
        capturedRedemption(d).output = obsOut as never;
      }, (r) => { r.assets[0]!.routeReviews[0]!.output = revOut as never; });
      expect(res.exitRoutes[0]!.factorStatuses?.capacity).toMatchObject({ observationState: "missing", applicability: { state: "required" } });
      expect(res.exitStatus.gapIds.some((id) => id.endsWith(":capacity"))).toBe(true);
    }
    const { res: usable } = runV((d) => {
      d.redemptionBackstopMap.alpha = {
        ...d.redemptionBackstopMap.alpha!, capacitySemantics: "immediate-bounded", capacityConfidence: "live-direct",
        capacityBasis: "live-direct-telemetry", immediateCapacityUsd: 1_000_000,
        capacityProfile: { ...d.redemptionBackstopMap.alpha!.capacityProfile!, immediateUsd: 1_000_000, scoringHorizon: "immediate", capacityProfileConfidence: "live-direct" },
      };
    });
    expect(usable.exitRoutes[0]!.factorStatuses?.capacity?.applicability.state).not.toBe("not-applicable");
    expect(usable.exitRoutes[0]!.capacityCurve.length).toBeGreaterThan(0);
  });

  it("applies physical-delivery capacity N/A only on documented-channel unavailable rails, preserving producer-failed quarantine and live-telemetry causes", () => {
    const t = Date.parse("2026-10-20T00:00:00Z") / 1_000;
    const cfg: RedemptionBackstopConfig = {
      routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "days", executionModel: "rules-based-nav",
      outputAssetType: "physical-commodity-delivery", capacityModel: { kind: "unquantified" }, costModel: fixedFee(0), reviewedAt: "2026-10-03",
      physicalCommodityDelivery: { commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 1, deliveryTermsUnbounded: true, feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false },
      v9RouteReviewTerms: { scoringDisposition: "bounded-terms-gap", missingScoringFields: ["capacity", "settlement", "cost"], reviewedAt: "2026-10-03", rationale: "Bounded terms gap matching xgz-goldzip." },
      docs: [{ label: "Physical gold terms", url: "https://issuer.example/gold-terms", supports: ["route", "access"] }],
    };
    const getConfig = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig").mockReturnValue(cfg);
    try {
      const runMode = (mode: "documented" | "documented-no-val" | "live-telemetry-missing" | "reserve-quarantine") => {
        const d = exactFixedInput({ clockSec: t, includeDexObservations: false, includeDexCoverage: false });
        d.pegDataById.alpha = {
          ...d.pegDataById.alpha!, pegCurrency: "GOLD",
          ...(mode === "documented-no-val" ? { pegReference: undefined } : { pegReference: { source: "fx", contributorCount: 1, asOf: t - 60, valueUsd: 2_500, usdPerTroyOunce: 2_500 } }),
        };
        if (mode === "live-telemetry-missing") {
          d.redemptionGenerationId = "redemption:phys-live";
          d.redemptionBackstopMap.alpha = {
            ...makeSupplyFullRedemption({ stablecoinId: "alpha", resolutionState: "missing-capacity", capacityProfile: undefined, updatedAt: t, outputAssetType: "physical-commodity-delivery" }),
            provider: "reserve-sync-metadata", capacityBasis: "live-direct-telemetry", routeStatus: "open",
          };
          d.redemptionStale = false;
          d.inputFreshness.redemptionBackstops = { updatedAt: t, ageSeconds: 0, stale: false };
        } else {
          delete d.redemptionBackstopMap.alpha;
          if (mode === "reserve-quarantine") d.pipelineGapByAssetId = { alpha: [captureRedemptionReserveQuarantine({ assetId: "alpha", redemptionGenerationId: d.redemptionGenerationId, routeFamily: cfg.routeFamily, reason: "stale", clockSec: t })] };
        }
        const rebuilt = rebuildFixed(d);
        const rev = reviewedFor(rebuilt, { withClock: true, emptyRoutes: true });
        const ctx = factBuilderContext(rebuilt, rev);
        const res = buildRoutes(ctx, buildSupply(ctx));
        expect(res.exitRoutes).toHaveLength(1);
        return { ctx, res };
      };
      const { ctx: docCtx, res: docRes } = runMode("documented");
      const naCap = { observationState: "known", gapIds: [], applicability: { state: "not-applicable", policyRuleId: "v9.exit.physical-delivery-capacity" } };
      expect(docRes.exitRoutes[0]!.output.kind).toBe("physical-commodity-delivery");
      expect(docRes.exitRoutes[0]!.status).toMatchObject(naCap);
      expect(docRes.exitRoutes[0]!.factorStatuses?.capacity).toMatchObject(naCap);
      expect([...docCtx.gaps.keys()].some((id) => id.endsWith(":capacity"))).toBe(false);
      expect(docRes.exitStatus.gapIds.some((id) => id.endsWith(":capacity"))).toBe(false);
      const compiledDoc = compileRouteFactorStatuses(docCtx, docRes.exitRoutes[0]!);
      expect(compiledDoc.factorStatuses.capacity).toMatchObject(naCap);
      for (const [k, rule] of [["access", "v9.exit.route-factors"], ["holderEligibility", "v9.exit.route-factors"], ["output", "v9.exit.output-valuation"]] as const) {
        expect(compiledDoc.factorStatuses[k]).toMatchObject({ observationState: "known", applicability: { state: "required", policyRuleId: rule } });
      }
      const { res: noVal } = runMode("documented-no-val");
      expect(noVal.exitRoutes[0]!.output).toMatchObject({ kind: "unknown", status: { observationState: "missing", applicability: { state: "required" } } });
      expect(noVal.exitRoutes[0]!.status).toMatchObject({ observationState: "missing", applicability: { state: "required" } });
      for (const [mode, rejectionCode] of [["live-telemetry-missing", "live-direct-capacity-unavailable"], ["reserve-quarantine", "redemption-reserve-input-stale"]] as const) {
        const { ctx, res } = runMode(mode);
        expect(res.exitRoutes[0]!.output.kind).toBe("physical-commodity-delivery");
        expect(res.exitRoutes[0]!.factorStatuses?.capacity).toMatchObject({ observationState: "missing", applicability: { state: "required" } });
        expect(res.exitStatus.gapIds.some((id) => id.endsWith(":capacity"))).toBe(true);
        expect(ctx.gaps.get(res.exitRoutes[0]!.status.gapIds[0]!)!).toMatchObject({ responsibility: "producer-failed", causeProof: { cause: "A", rejectionCode } });
      }
    } finally { getConfig.mockRestore(); }
  });
});
