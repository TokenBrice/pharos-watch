import { describe, expect, it } from "vitest";
import type { BridgeRouteRiskProfile } from "@shared/types/core";
import {
  SafetyScoreV9DeploymentSupplyCensusSchema,
  type SafetyScoreV9DeploymentSupplyCensus,
  type V9DeploymentSupplyCensusRow,
} from "@shared/types/safety-score-v9-deployment-supply-census";
import type { V9FactGapV3 } from "@shared/types/safety-score-v9-facts";
import type { V9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control-primitives";
import type { SafetyScoreV9FactSetExtensionV2 } from "../safety-score-v9/fact-set-schema";
import {
  classifyV9DocumentationGap,
  type V9DocumentationAssetFacts,
} from "@shared/lib/safety-score-v9/documentation";
import { provenNullShareDeploymentBound } from "@shared/lib/safety-score-v9/control-bridge-join";
import { evaluateV9EconomicControl } from "@shared/lib/safety-score-v9/control";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { createV9FactGapV3 } from "@shared/lib/safety-score-v9/reasons";
import {
  boundedUnknown,
  makeDeploymentControl,
  makeEconomicControlArgs,
  makeEconomicControlFacts,
  makeSupplyPartition,
  requiredKnown,
} from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import { compileNativeV3FactSet, coreFixture } from "@shared/lib/__tests__/safety-score-v9-facts.fixture-support";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  buildSafetyScoreV9SupplyReview,
  deploymentSupplyCensusDiagnostics,
  safetyScoreV9RouteSupplyShare,
  V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW,
} from "../safety-score-v9/extension-supply";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import {
  deriveNativeV9BaseInputGenerationId,
  normalizeSafetyScoreV9CompilerInput,
} from "../safety-score-v9/native-input";
import { buildSafetyScoreV9ReplayArtifact } from "../../../scripts/replay-safety-score-v9";
import recordedGeneration from "./fixtures/deployment-supply-census-admission/recorded-rpc-generation.json";
import shareBoundaryRows from "./fixtures/deployment-supply-census-admission/share-boundary-rows.json";

/**
 * SA-6 end-to-end proof of v10.38 census admission through SA-3's consumer.
 *
 * Fixtures are copies of p-census SA-2a's recorded RPC generation
 * (`recorded-rpc-generation.json`, verbatim request bodies plus the rows the
 * reader produced at a pinned header) and its deterministic 1% boundary
 * generation (`share-boundary-rows.json`, exact integer reads). The tests build
 * the C4 packet the way SA-5 does — rows plus row-derived conservation — and
 * never import a p-census module.
 */

const SUPPLY_POLICY = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution;
const RECORDED_CLOCK_SEC = recordedGeneration.clockSec;
const BOUNDARY_CLOCK_SEC = shareBoundaryRows.policy.documentationImmaterialSharePct === 1
  ? shareBoundaryRows.documents.pin.blockTimeSec + 60
  : 0;
const BOUNDARY_ROUTE = shareBoundaryRows.documents.routeId;
const BREACH_ROUTE = `movement:0x${"c".repeat(64)}`;
const USDC_ASSET = "usdc-circle";

type SupplyReview = NonNullable<SafetyScoreV9FactSetExtensionV2["assets"][number]["supplyReview"]>;

const compiledBase = compileNativeV3FactSet(coreFixture());
const baseDocumentationFacts = compiledBase.assets.find((asset) => asset.assetId === "alpha")!;

interface PacketOptions {
  readonly aggregateSupplyUsd: number;
  readonly observedAtSec: number;
  readonly rosterComplete?: boolean;
  readonly conserved?: boolean;
  readonly rejected?: SafetyScoreV9DeploymentSupplyCensus["rejected"];
}

function packetFromRows(
  rows: readonly V9DeploymentSupplyCensusRow[],
  options: PacketOptions,
): SafetyScoreV9DeploymentSupplyCensus {
  return {
    model: "deployment-supply-census-v1",
    observedAtSec: options.observedAtSec,
    deployments: [...rows],
    conservation: {
      aggregateSupplyUsd: options.aggregateSupplyUsd,
      measuredSupplyUsd: rows.reduce((sum, row) => sum + row.supplyUsdUpper, 0),
      measuredShareSum: rows.reduce((sum, row) => sum + row.shareUpper, 0),
      relativeTolerance: SUPPLY_POLICY.conservationRelativeTolerance,
      absoluteToleranceUsd: SUPPLY_POLICY.conservationAbsoluteToleranceUsd,
      rosterComplete: options.rosterComplete ?? true,
      conserved: options.conserved ?? true,
    },
    rejected: [...(options.rejected ?? [])],
  };
}

function profileWithRoutes(routeIds: readonly string[]): BridgeRouteRiskProfile {
  return {
    routes: routeIds.map((id) => ({
      id,
      reviewDisposition: "reviewed",
      issuanceModel: "bridge-representation",
    })),
  } as unknown as BridgeRouteRiskProfile;
}

function chainSupply(current: number) {
  return { current, circulatingPrevDay: current, circulatingPrevWeek: current, circulatingPrevMonth: current };
}

function fixedInput(options: {
  assetId: string;
  clockSec: number;
  aggregateUsd: number;
  chains: Record<string, number>;
  packet?: SafetyScoreV9DeploymentSupplyCensus;
}) {
  return {
    ...makeV9FixedInput({
      assetId: options.assetId,
      clockSec: options.clockSec,
      aggregateCirculating: { peggedUSD: options.aggregateUsd },
      chainSupplyByChain: Object.fromEntries(
        Object.entries(options.chains).map(([chain, current]) => [chain, chainSupply(current)]),
      ),
    }),
    ...(options.packet === undefined
      ? {}
      : { safetyScoreV9DeploymentSupplyCensusById: { [options.assetId]: options.packet } }),
  };
}

function factsFromReview(review: SupplyReview) {
  const supply = makeSupplyPartition({
    routes: review.selectedBridgeRoutes.map((row) => ({
      deploymentRouteKey: row.deploymentRouteKey,
      supplyShare: row.supplyShare,
      supplyUsd: row.supplyUsd,
      reviewState: row.reviewState,
      ...(row.reviewedRouteKind === undefined ? {} : { reviewedRouteKind: row.reviewedRouteKind }),
      ...(row.evidenceKind === undefined ? {} : { evidenceKind: row.evidenceKind }),
    })),
  });
  const control = makeDeploymentControl("bridge:recorded", "bridge", {
    scope: "deployment",
    deploymentKey: BOUNDARY_ROUTE,
    economicLossScope: "deployment",
    materialSupplyShare: null,
    status: boundedUnknown("control.recorded"),
  });
  return {
    control,
    facts: makeEconomicControlFacts([control], {
      assetId: "census-boundary",
      supply,
      controlStatus: requiredKnown("controls"),
    }),
  };
}

function materialityGap(controlKey: string) {
  return createV9FactGapV3({
    gapId: `census-boundary:gap:control:${controlKey}:incidentState`,
    reasonCode: "unresolved-control-identity",
    ownerDomain: "control",
    policyRuleId: `control.${controlKey}`,
    observationState: "bounded-unknown",
    responsibility: "unresearched",
    path: { kind: "local-component", componentKey: `control:${controlKey}` },
    message: "Deployment materiality is not yet measured.",
    causeProof: { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] },
    causeScope: {
      pillar: "control",
      componentKey: `control:${controlKey}`,
      factorKey: "incidentState",
      routeKey: null,
      exposureId: null,
      requiredDatum: `${controlKey}:materialSupplyShare`,
    },
  });
}

function documentationFacts(facts: V9EconomicControlAssetFacts, gap: V9FactGapV3): V9DocumentationAssetFacts {
  return {
    assetId: facts.assetId,
    archetype: facts.archetype,
    controlStatus: facts.controlStatus,
    controls: [...facts.controls],
    gaps: [gap],
    supply: {
      ...baseDocumentationFacts.supply,
      selectedBridgeRoutes: facts.supply.selectedBridgeRoutes,
      selectedRouteSupplyShare: facts.supply.selectedRouteSupplyShare,
      unknownRouteSupplyShare: facts.supply.unknownRouteSupplyShare,
      unreviewedRouteSupplyShare: facts.supply.unreviewedRouteSupplyShare,
    },
    economicControlReview: baseDocumentationFacts.economicControlReview,
    reserveExposures: [],
    exitRoutes: [],
  };
}

const recordedRows = recordedGeneration.census.rows as unknown as V9DeploymentSupplyCensusRow[];
const boundaryDocumentsRow = shareBoundaryRows.documents as unknown as V9DeploymentSupplyCensusRow;
const boundaryRequiredRow = shareBoundaryRows.required as unknown as V9DeploymentSupplyCensusRow;
const recordedPacket = packetFromRows(recordedRows, {
  aggregateSupplyUsd: recordedGeneration.aggregateSupplyUsd,
  observedAtSec: RECORDED_CLOCK_SEC,
});
const boundaryPacket = packetFromRows([boundaryDocumentsRow], {
  aggregateSupplyUsd: boundaryDocumentsRow.supplyUsdUpper / boundaryDocumentsRow.shareUpper,
  observedAtSec: BOUNDARY_CLOCK_SEC,
});
const atBarPacket = packetFromRows([boundaryRequiredRow], {
  aggregateSupplyUsd: boundaryRequiredRow.supplyUsdUpper / boundaryRequiredRow.shareUpper,
  observedAtSec: BOUNDARY_CLOCK_SEC,
});

describe("v10.38 deployment supply census admission (end to end)", () => {
  it("admits a recorded sub-bar bound as a reconciled partition the documentation class reads", () => {
    // The fixture packet is a valid C4 generation, not a hand-waved row set.
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(boundaryPacket)).toEqual(boundaryPacket);

    const input = fixedInput({
      assetId: "census-boundary",
      clockSec: BOUNDARY_CLOCK_SEC,
      aggregateUsd: boundaryPacket.conservation.aggregateSupplyUsd,
      chains: { ethereum: boundaryPacket.conservation.aggregateSupplyUsd },
      packet: boundaryPacket,
    });
    const review = buildSafetyScoreV9SupplyReview(
      input,
      "census-boundary",
      profileWithRoutes([BOUNDARY_ROUTE]),
    )!;
    const rows = new Map(review.selectedBridgeRoutes.map((row) => [row.deploymentRouteKey, row]));
    expect(rows.get(BOUNDARY_ROUTE)).toMatchObject({ evidenceKind: "upper-bound", reviewState: "selected-reviewed" });
    expect(rows.get(BOUNDARY_ROUTE)!.supplyShare).toBeCloseTo(0.009999, 12);
    // Everything the census did not measure stays in one ambiguous residual, so
    // the partition reconciles to the whole without narrowing a sibling to zero.
    expect(rows.get("ambiguous-chain:census-boundary:ethereum")).toMatchObject({ reviewState: "unmatched" });
    expect(review.selectedBridgeRoutes.reduce((sum, row) => sum + row.supplyShare, 0)).toBeCloseTo(1, 9);
    expect(deploymentSupplyCensusDiagnostics(review)).toEqual([]);
    // The bound is never a share a control can price directly.
    expect(safetyScoreV9RouteSupplyShare(review, BOUNDARY_ROUTE)).toBeNull();

    const { control, facts } = factsFromReview(review);
    const bound = provenNullShareDeploymentBound(facts, control);
    expect(bound).toBeCloseTo(0.009999, 12);
    expect(bound!).toBeLessThan(0.01);
    // Price-neutral: no share is written onto the control.
    expect(control.materialSupplyShare).toBeNull();

    // The documentation predicate reads the same bound and the same partition.
    const gap = materialityGap(control.controlKey);
    const classification = classifyV9DocumentationGap(
      V9_CANDIDATE_POLICY_V1,
      documentationFacts(facts, gap),
      gap,
    );
    expect(classification).toMatchObject({
      reason: "immaterial-deployment",
      threshold: { kind: "known-share-pct", value: 0.01, evidenceKind: "upper-bound" },
    });

    // The same census partition never gives a global-scope control a share datum.
    const globalControl = makeDeploymentControl("bridge:global", "bridge", {
      scope: "global",
      deploymentKey: BOUNDARY_ROUTE,
      economicLossScope: "global-claim",
      materialSupplyShare: null,
      status: boundedUnknown("control.global"),
    });
    const globalFacts = makeEconomicControlFacts([globalControl], {
      assetId: "census-boundary",
      supply: facts.supply,
    });
    expect(provenNullShareDeploymentBound(globalFacts, globalControl)).toBeNull();
    const globalGap = materialityGap(globalControl.controlKey);
    expect(classifyV9DocumentationGap(
      V9_CANDIDATE_POLICY_V1,
      documentationFacts(globalFacts, globalGap),
      globalGap,
    )).toBeNull();

    // The scorer's own binding predicate agrees: the deployment is non-binding.
    const evaluated = evaluateV9EconomicControl(makeEconomicControlArgs({
      facts,
      bridge: { status: requiredKnown("bridge"), routes: [{ controlKey: control.controlKey, tier: "issuer-native-burn-mint" }] },
    }));
    expect(evaluated.reasons.map((reason) => reason.code)).not.toContain("runtime-bridge-materiality-unavailable");
    expect(evaluated.reasons.map((reason) => reason.code)).not.toContain("selected-bridge-route-unresolved");
  });

  it("isolates the scorer read: the same control without the census datum stays required", () => {
    const input = fixedInput({
      assetId: "census-boundary",
      clockSec: BOUNDARY_CLOCK_SEC,
      aggregateUsd: boundaryPacket.conservation.aggregateSupplyUsd,
      chains: { ethereum: boundaryPacket.conservation.aggregateSupplyUsd },
    });
    const review = buildSafetyScoreV9SupplyReview(
      input,
      "census-boundary",
      profileWithRoutes([BOUNDARY_ROUTE]),
    )!;
    expect(review.selectedBridgeRoutes.some((row) => row.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(review)).toEqual([]);

    const { control, facts } = factsFromReview(review);
    expect(provenNullShareDeploymentBound(facts, control)).toBe(1);
    const evaluated = evaluateV9EconomicControl(makeEconomicControlArgs({
      facts,
      bridge: { status: requiredKnown("bridge"), routes: [{ controlKey: control.controlKey, tier: "issuer-native-burn-mint" }] },
    }));
    expect(evaluated.reasons.map((reason) => reason.code)).toContain("runtime-bridge-materiality-unavailable");
  });

  it("requires the datum at the strict 1% bar recorded by the boundary generation", () => {
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(atBarPacket)).toEqual(atBarPacket);
    expect(atBarPacket.deployments[0]!.shareUpper).toBeGreaterThanOrEqual(0.01);

    const review = buildSafetyScoreV9SupplyReview(
      fixedInput({
        assetId: "census-boundary",
        clockSec: BOUNDARY_CLOCK_SEC,
        aggregateUsd: atBarPacket.conservation.aggregateSupplyUsd,
        chains: { ethereum: atBarPacket.conservation.aggregateSupplyUsd },
        packet: atBarPacket,
      }),
      "census-boundary",
      profileWithRoutes([BOUNDARY_ROUTE]),
    )!;
    // No reviewed escrow rule exists, so ≥1% never becomes a share or a bound.
    expect(review.selectedBridgeRoutes.some((row) => row.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(review)).toContainEqual({
      deploymentRouteKey: BOUNDARY_ROUTE,
      code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW,
    });

    const { control, facts } = factsFromReview(review);
    expect(provenNullShareDeploymentBound(facts, control)).not.toBeNull();
    expect(provenNullShareDeploymentBound(facts, control)!).toBeGreaterThanOrEqual(0.01);
    const gap = materialityGap(control.controlKey);
    expect(classifyV9DocumentationGap(V9_CANDIDATE_POLICY_V1, documentationFacts(facts, gap), gap)).toBeNull();
  });

  it("returns every deployment datum to required when the recorded bound is expired", () => {
    const expiredClock = RECORDED_CLOCK_SEC + SUPPLY_POLICY.observationMaxAgeSec + 1;
    const expiredInput = fixedInput({
      assetId: USDC_ASSET,
      clockSec: expiredClock,
      aggregateUsd: recordedGeneration.aggregateSupplyUsd,
      chains: recordedGeneration.chainSupplyUsdByChainId,
      packet: recordedPacket,
    });
    const profile = profileWithRoutes(recordedRows.map((row) => row.routeId));
    const expired = buildSafetyScoreV9SupplyReview(expiredInput, USDC_ASSET, profile)!;
    // The packet is still a valid generation; only its clock is past the window.
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(recordedPacket)).toEqual(recordedPacket);
    expect(deploymentSupplyCensusDiagnostics(expired)).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:observation-stale" },
    ]);
    expect(expired.selectedBridgeRoutes.some((row) => row.evidenceKind === "upper-bound")).toBe(false);
    // No carry-forward, no re-dating: the review is the ordinary lane's review.
    const current = buildSafetyScoreV9SupplyReview(
      fixedInput({
        assetId: USDC_ASSET,
        clockSec: expiredClock,
        aggregateUsd: recordedGeneration.aggregateSupplyUsd,
        chains: recordedGeneration.chainSupplyUsdByChainId,
      }),
      USDC_ASSET,
      profile,
    )!;
    expect(expired).toEqual(current);
  });

  it("never admits a recorded ≥1% generation as a share and keeps the ordinary lane", () => {
    const input = fixedInput({
      assetId: USDC_ASSET,
      clockSec: RECORDED_CLOCK_SEC,
      aggregateUsd: recordedGeneration.aggregateSupplyUsd,
      chains: recordedGeneration.chainSupplyUsdByChainId,
      packet: recordedPacket,
    });
    const profile = profileWithRoutes(recordedRows.map((row) => row.routeId));
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(recordedPacket)).toEqual(recordedPacket);
    const withCensus = buildSafetyScoreV9SupplyReview(input, USDC_ASSET, profile)!;
    expect(recordedRows.every((row) => row.shareUpper >= 0.01)).toBe(true);
    expect(withCensus.selectedBridgeRoutes.some((row) => row.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(withCensus)).toEqual(
      recordedRows
        .map((row) => row.routeId)
        .sort()
        .map((routeId) => ({ deploymentRouteKey: routeId, code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW })),
    );
    for (const row of recordedRows) {
      // Whatever the ordinary lane attributes, no census row is admitted.
      expect(withCensus.selectedBridgeRoutes.some((candidate) => candidate.deploymentRouteKey === row.routeId &&
        candidate.evidenceKind === "upper-bound")).toBe(false);
    }
    // The published partition is exactly the one the capture had before the
    // census existed: a non-admitting packet only adds its reasoned band.
    const withoutCensus = buildSafetyScoreV9SupplyReview(
      fixedInput({
        assetId: USDC_ASSET,
        clockSec: RECORDED_CLOCK_SEC,
        aggregateUsd: recordedGeneration.aggregateSupplyUsd,
        chains: recordedGeneration.chainSupplyUsdByChainId,
      }),
      USDC_ASSET,
      profile,
    )!;
    expect(withCensus).toEqual(withoutCensus);
  });

  it("rejects the usdcx-movement 100.4% conservation breach and admits no row", () => {
    const breach = packetFromRows([], {
      aggregateSupplyUsd: 1_000_000_000,
      observedAtSec: RECORDED_CLOCK_SEC,
      rosterComplete: true,
      conserved: false,
      rejected: [{ routeId: BREACH_ROUTE, code: "census-rejected:conservation-breach" }],
    });
    // A breach is representable: declared totals are still the packet's own rows.
    expect(SafetyScoreV9DeploymentSupplyCensusSchema.parse(breach)).toEqual(breach);
    const review = buildSafetyScoreV9SupplyReview(
      fixedInput({
        assetId: "census-breach",
        clockSec: RECORDED_CLOCK_SEC,
        aggregateUsd: 1_000_000_000,
        chains: { ethereum: 1_100_000_000 },
        packet: breach,
      }),
      "census-breach",
      profileWithRoutes([`ethereum:0x${"d".repeat(40)}`]),
    )!;
    expect(review.selectedBridgeRoutes.some((row) => row.evidenceKind === "upper-bound")).toBe(false);
    expect(deploymentSupplyCensusDiagnostics(review)).toEqual([
      { deploymentRouteKey: null, code: "census-rejected:conservation-breach" },
      { deploymentRouteKey: BREACH_ROUTE, code: "census-rejected:conservation-breach" },
    ]);
  });

  it("leaves a capture without a census map unchanged through replay normalization", () => {
    // The census is an accepted enrichment: the base-input identity must not move
    // when a capture gains it, so a capture that never carried the map replays as-is.
    const capture = fixedInput({
      assetId: USDC_ASSET,
      clockSec: RECORDED_CLOCK_SEC,
      aggregateUsd: recordedGeneration.aggregateSupplyUsd,
      chains: recordedGeneration.chainSupplyUsdByChainId,
    });
    const enriched = { ...capture, safetyScoreV9DeploymentSupplyCensusById: { [USDC_ASSET]: recordedPacket } };
    expect(normalizeSafetyScoreV9CompilerInput(capture).safetyScoreV9DeploymentSupplyCensusById).toBeUndefined();
    expect(normalizeSafetyScoreV9CompilerInput(enriched).safetyScoreV9DeploymentSupplyCensusById)
      .toEqual({ [USDC_ASSET]: recordedPacket });
    expect(deriveNativeV9BaseInputGenerationId(enriched as never))
      .toBe(deriveNativeV9BaseInputGenerationId(capture as never));
    expect(ACTIVE_META_BY_ID.has(USDC_ASSET)).toBe(true);
  });

  it("replays the same candidate with and without the non-admitting recorded packet", () => {
    const capture = fixedInput({
      assetId: USDC_ASSET,
      clockSec: RECORDED_CLOCK_SEC,
      aggregateUsd: recordedGeneration.aggregateSupplyUsd,
      chains: recordedGeneration.chainSupplyUsdByChainId,
    });
    const enriched = { ...capture, safetyScoreV9DeploymentSupplyCensusById: { [USDC_ASSET]: recordedPacket } };
    const artifactOf = (value: unknown) => buildSafetyScoreV9ReplayArtifact({
      fixedInput: value,
      publishedAtSec: RECORDED_CLOCK_SEC + 10,
    });
    const baseline = artifactOf(capture);
    const replay = artifactOf(enriched);
    // Every published scoring surface is identical; only the reasoned census
    // band (and the content digests that cover it) is new.
    const scoringSurface = (candidate: unknown): Record<string, unknown> => {
      const {
        factSetDigest: _factSetDigest,
        publicationGenerationId: _publicationGenerationId,
        resultDigest: _resultDigest,
        ...surface
      } = candidate as Record<string, unknown>;
      return surface;
    };
    expect(scoringSurface(replay.pipeline.candidate)).toEqual(scoringSurface(baseline.pipeline.candidate));
    const band = replay.pipeline.bridgeJoinDiagnostics.find((row) => row.assetId === USDC_ASSET);
    expect(band?.deploymentSupplyCensus).toEqual(
      recordedRows
        .map((row) => row.routeId)
        .sort()
        .map((routeId) => ({ deploymentRouteKey: routeId, code: V9_DEPLOYMENT_SUPPLY_SHARE_REQUIRES_REVIEWED_ESCROW })),
    );
    expect(baseline.pipeline.bridgeJoinDiagnostics
      .find((row) => row.assetId === USDC_ASSET)?.deploymentSupplyCensus).toBeUndefined();
  });
});
