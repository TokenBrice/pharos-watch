import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { createSupplyAttributionJournalV1 } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  V9_CANDIDATE_POLICY_V1,
  loadV9MethodologyPolicy,
} from "@shared/lib/safety-score-v9/policy";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
} from "../safety-score-v9/fact-set";
import type { ReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import {
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
} from "../safety-score-v9/xaut-supply-attribution-contract";
import {
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeXautObservation,
  makeV9FixedInput as exactFixedInput,
  makeV9Extension as extension,
  v9Status,
  withV9WmReviewedDeploymentAttribution as withWmReviewedDeploymentAttribution,
} from "../../test-helpers/v9-fixed-input";
import {
  XAUT_FACT_SET_CLOCK_SEC,
  wmFactSetFixedInput,
  wmFactSetMeta,
  xautFactSetFixedInput,
  xautFactSetMeta,
} from "./safety-score-v9-fact-set.test-support";

function nullSupplyReviewExtension(options: {
  bridge?: "not-applicable" | "missing" | "required";
  chainSupplyObservedAtSec?: number;
} = {}) {
  const value = structuredClone(extension());
  const asset = value.assets[0]!;
  asset.supplyReview = null;
  if (options.bridge === "missing") {
    asset.economicControlReview = null;
  } else if (options.bridge === "required") {
    asset.economicControlReview = {
      ...asset.economicControlReview!,
      bridge: {
        ...asset.economicControlReview!.bridge,
        status: v9Status("known", "v9.control.bridge-review"),
      },
    };
  }
  if (options.chainSupplyObservedAtSec !== undefined) {
    value.sources.chainSupply.observedAtSec = options.chainSupplyObservedAtSec;
  }
  return value;
}

function rejectedWmAttributionRecord(
  fixed: ReturnType<typeof exactFixedInput>,
  completedAtSec: number,
  rejectionCode: "chain-rpc-unavailable" | "deployment-state-unavailable",
) {
  return createSupplyAttributionJournalV1({
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: "wm-m0",
    attemptId: `supply-attribution:fixture:${completedAtSec}`,
    sourceId: "wm.reviewed-deployment-unit-partition.v1",
    sourceOriginClass: "onchain-observation",
    baseInputGenerationId: fixed.baseInputGenerationId,
    sourceGeneration: fixed.sourceGeneration,
    registryFingerprint: fixed.registryFingerprint,
    routeInventoryDigest: fixed.registryFingerprint,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode: "supply-attribution.admission.rejected-upstream",
    fallbackCode: "supply-attribution.fallback.aggregate-only",
    rejectionCode,
    attemptedAtSec: completedAtSec - 1,
    completedAtSec,
    scoringClockSec: fixed.clockSec,
    sourceObservedAtSec: null,
    failedRouteId: null,
    contentSha256: null,
  });
}

const XAUT_NON_BRIDGE_CONTROL_CASES = [
  {
    controlKind: "mint", scope: "deployment", capabilities: ["mint"],
    deploymentKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
    authority: {
      authorityKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
      model: "contract", threshold: null,
    },
  },
  {
    controlKind: "upgrade", scope: "deployment", capabilities: ["mint", "upgrade"],
    deploymentKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
    authority: {
      authorityKey: "ethereum:0xc6cde7c39eb2f0f0095f41570af89efc2c1ea828",
      model: "multisig", threshold: { required: 3, total: 6 },
    },
  },
] as const;

const XAUT_COMMON_MODE_SIGNAL_CASES = [
  { failureDomainKey: "bridge-route:contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c" },
  { failureDomainKey: "bridge-route:protocol:xaut0-omnichain" },
] as const;

function reviewedXautGroupFixture() {
  const clockSec = XAUT_FACT_SET_CLOCK_SEC;
  const fixed = xautFactSetFixedInput({
    chainSupplyByChain: {},
    aggregateCirculating: { peggedGOLD: 2_480_000_000 },
    omitLiveReserve: true,
  });
  const attribution = deriveXautRepresentationGroupSupplyAttribution({
    aggregateSupplyUsd: 2_480_000_000,
    registryFingerprint: fixed.registryFingerprint,
    scoringClockSec: fixed.clockSec,
    observation: makeXautObservation({
      clockSec,
      blockTimeSec: clockSec - 2_800,
      disclosure: { sourceTimestampSec: clockSec - 2_900, responseSha256: "e".repeat(64) },
    }),
  });
  fixed.safetyScoreV9SupplyAttributionById = { "xaut-tether": attribution! };
  fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
  const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([["xaut-tether", xautFactSetMeta()]]),
  });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
  const xaut = compiled.assets[0]!;
  return {
    attribution,
    bridgeControls: xaut.controls.filter((control) => control.controlKind === "bridge"),
    clockSec,
    compiled,
    groupRow: xaut.supply.selectedBridgeRoutes.find((route) =>
      route.deploymentRouteKey.startsWith("representation-group:")),
    supplyEvidence: xaut.evidence.find((evidence) => evidence.evidenceId === "xaut-tether:chain-supply"),
    xaut,
  };
}

function wmFixedInput() {
  return wmFactSetFixedInput({
    chainSupplyByChain: {},
    aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
    omitLiveReserve: true,
  });
}

function compileWm(fixed: ReportCardsFixedInput) {
  const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([["wm-m0", wmFactSetMeta()]]),
  });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
  return { baseline, compiled, wm: compiled.assets[0]! };
}

describe("Safety Score v9 exact base fact-set adapter — supply attribution", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("aggregates chain aliases and conserves unresolved source supply without price multiplication", () => {
    const original = exactFixedInput();
    const template = original.chainCirculatingById.alpha!.ethereum!;
    const fixed = exactFixedInput({
      chainSupplyByChain: {
        Ethereum: { ...template, current: 6_000_000 },
        ethereum: { ...template, current: 4_000_000 },
        "Hyperliquid L1": { ...template, current: 3_000_000 },
        "hyperliquid-l1": { ...template, current: 2_000_000 },
        "Future Network": { ...template, current: 1_000_000 },
        "Zero Network": { ...template, current: 0 },
      },
    });

    const supply = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.supply;
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUsd).toBe(16_000_000);
    expect(supply.chainDistribution).toEqual({
      chains: [
        { chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 10 / 16 },
        { chainId: "hyperliquid", supplyUsd: 5_000_000, supplyShare: 5 / 16 },
      ],
      unattributedSupplyUsd: 1_000_000,
      unattributedSupplyShare: 1 / 16,
    });
    expect(supply.failureDomains).toEqual(
      expect.arrayContaining([
        { kind: "chain", key: "future network" },
        { kind: "chain", key: "hyperliquid" },
        { kind: "chain", key: "zero network" },
      ]),
    );
  });

  it("falls back to the aggregate circulating bucket when no per-chain rows exist", () => {
    const fixed = exactFixedInput({
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 4_000_000, peggedEUR: 1_000_000 },
    });

    const supply = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!.supply;
    expect(supply.status.observationState).toBe("known");
    expect(supply.sourceKind).toBe("aggregate-circulating");
    expect(supply.circulatingUsd).toBe(5_000_000);
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUnits).toBeNull();
    expect(supply.chainDistribution).toBeNull();
    expect(supply.failureDomains).toEqual([]);
    expect(supply.selectedBridgeRoutes).toEqual([]);
    expect(supply.selectedRouteSupplyShare).toBeNull();
    expect(supply.unknownRouteSupplyShare).toBeNull();
    expect(supply.unreviewedRouteSupplyShare).toBeNull();
  });

  it("compiles exact wM route shares without bridge-materiality uncertainty", () => {
    const fixed = withWmReviewedDeploymentAttribution(wmFixedInput());
    const { baseline, compiled, wm } = compileWm(fixed);

    expect(wm.supply.status.observationState).toBe("known");
    expect(wm.supply.selectedBridgeRoutes).toHaveLength(5);
    expect(wm.supply.selectedRouteSupplyShare).toBe(1);
    expect(wm.supply.unknownRouteSupplyShare).toBe(0);
    expect(wm.supply.unreviewedRouteSupplyShare).toBe(0);
    expect(wm.gaps.map((gap) => gap.reasonCode)).not.toContain(
      "runtime-bridge-materiality-unavailable",
    );
    expect(
      wm.evidence.find((evidence) => evidence.evidenceId === "wm-m0:chain-supply"),
    ).toMatchObject({
      sourceId: "safety-score-v9-reviewed-deployment-attribution",
      freshness: {
        maxAgeSec: baseline.sources.chainSupply.maxAgeSec,
      },
    });

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.scoreInput.pillars.control.reasons.map((reason) => reason.code)).not.toContain(
      "runtime-bridge-materiality-unavailable",
    );
  });

  it("compiles one reviewed XAUt0 group control without destination supply claims", () => {
    const {
      attribution, bridgeControls, clockSec, compiled, groupRow, supplyEvidence, xaut,
    } = reviewedXautGroupFixture();
    expect(attribution).not.toBeNull();
    expect(xaut.supply.status.observationState).toBe("known");
    expect(supplyEvidence).toMatchObject({
      observedAtSec: clockSec - 2_800,
      freshness: { state: "current", ageSec: 2_800, maxAgeSec: XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC },
    });
    expect(xaut.supply.selectedBridgeRoutes).toHaveLength(2);
    expect(groupRow).toMatchObject({
      reviewState: "selected-reviewed",
      reviewedRouteKind: "controlled",
      supplyShare: expect.closeTo(0.04849813227, 9),
    });
    expect(xaut.supply.selectedRouteSupplyShare).toBe(1);
    expect(xaut.supply.unknownRouteSupplyShare).toBe(0);
    expect(xaut.supply.chainDistribution).toMatchObject({
      chains: [{ chainId: "ethereum", supplyShare: expect.closeTo(0.95150186773, 9) }],
      unattributedSupplyShare: expect.closeTo(0.04849813227, 9),
    });
    expect(bridgeControls).toHaveLength(1);
    expect(bridgeControls[0]).toMatchObject({
      status: { applicability: { state: "required" }, observationState: "known", gapIds: [] },
      deploymentKey: "representation-group:xaut-tether:xaut0-omnichain",
      capSemantics: { kind: "unbounded" },
      claimImpairment: "unbounded",
      economicLossScope: "deployment",
      materialSupplyShare: expect.closeTo(0.04849813227, 9),
      authority: {
        authorityKey: "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
        model: "unknown",
      },
      failureDomains: [
        { kind: "bridge-route", key: "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c" },
        { kind: "bridge-route", key: "protocol:xaut0-omnichain" },
      ],
    });
    expect(xaut.economicControlReview.bridge.status.observationState).toBe("known");
    expect(bridgeControls.some((control) =>
      attribution!.representationGroup.routeIds.includes(control.deploymentKey))).toBe(false);
    expect(
      xaut.controls
        .filter((control) => control.controlKind !== "bridge")
        .map((control) => ({
          controlKind: control.controlKind,
          scope: control.scope,
          capabilities: control.capabilities,
          deploymentKey: control.deploymentKey,
          authority: control.authority,
        }))
        .sort((left, right) =>
          (left.authority?.authorityKey ?? "").localeCompare(right.authority?.authorityKey ?? "")),
    ).toEqual(XAUT_NON_BRIDGE_CONTROL_CASES);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    const reasonCodes = evaluated.scoreInput.pillars.control.reasons.map((reason) => reason.code);
    expect(reasonCodes).not.toContain("immaterial-unrecognized-chain-pool");
    expect(reasonCodes).not.toContain("material-bridge-supply-unmatched");
    const commonModePolicy = loadV9MethodologyPolicy({
      ...V9_CANDIDATE_POLICY_V1.policy,
      policyId: "safety-score-v9-xaut-common-mode-test",
      semantic: {
        ...V9_CANDIDATE_POLICY_V1.policy.semantic,
        materiality: { ...V9_CANDIDATE_POLICY_V1.policy.semantic.materiality, commonControlMinAssets: 1 },
      },
    });
    const commonModeSignals = evaluateV9FactSet(
      compiled, commonModePolicy,
    ).assets[0]!.scoreInput.dependencyStructuralSignals.filter((signal) =>
      signal.failureDomainKeys.some((key) => key.startsWith("bridge-route:")));
    expect(commonModeSignals).toEqual(
      XAUT_COMMON_MODE_SIGNAL_CASES.map(({ failureDomainKey }) =>
        expect.objectContaining({
          failureDomainKeys: [failureDomainKey],
          materialSharePct: expect.closeTo(4.849813227, 7),
          severity: "low",
          responsibility: "measured-adverse",
        })),
    );
  });

  it("withholds XAUT when no reconciled V2 supply packet can establish global chain supply", () => {
    const fixed = xautFactSetFixedInput({
      chainSupplyByChain: {},
      omitLiveReserve: true,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["xaut-tether", xautFactSetMeta()]]),
    });
    const compiled =
      compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const xaut = compiled.assets[0]!;

    expect(xaut.supply.status.observationState).toBe("missing");
    expect(xaut.gaps).toContainEqual(
      expect.objectContaining({
        reasonCode: "missing-pillar-evidence",
        ownerDomain: "evidence",
        responsibility: "producer-failed",
        path: {
          kind: "local-component",
          componentKey: "chain-supply",
        },
      }),
    );

    const evaluated = evaluateV9FactSet(
      compiled,
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(evaluated.trace.finalScore).toBeNull();
    expect(evaluated.trace.finalGrade).toBe("NR");
    expect(evaluated.trace.nrReasons).toContainEqual(
      expect.objectContaining({
        code: "missing-pillar-evidence",
        responsibility: "producer-failed",
      }),
    );
    expect(evaluated.trace.unresolvedFacts).toContainEqual(
      expect.objectContaining({
        code: "missing-pillar-evidence",
        critical: true,
        responsibility: "producer-failed",
      }),
    );
  });

  it("fails closed when the circulating-liability denominator pushes XAUt0 above materiality", () => {
    const clockSec = XAUT_FACT_SET_CLOCK_SEC;
    const aggregateSupplyUsd = 2_480_000_000;
    const fixed = xautFactSetFixedInput({
      liquidityScore: 95,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedGOLD: aggregateSupplyUsd },
    });
    const attribution = deriveXautRepresentationGroupSupplyAttribution({
      aggregateSupplyUsd,
      registryFingerprint: fixed.registryFingerprint,
      scoringClockSec: fixed.clockSec,
      observation: makeXautObservation({
        clockSec,
        canonicalTotalSupplyRaw: "1000000000",
        treasuryBalanceRaw: "100000000",
        adapterLockedSupplyRaw: "95000000",
        blockTimeSec: clockSec - 100,
        blockHash: `0x${"cd".repeat(32)}`,
        disclosure: {
          sourceTimestampSec: clockSec - 200, responseSha256: "f".repeat(64),
          totalAuthorizedRaw: "1000000000", notIssuedRaw: "100000000", quarantinedRaw: "0",
        },
      }),
    });
    expect(attribution).not.toBeNull();
    const groupShare = attribution!.representationGroup.currentSupplyUsd / aggregateSupplyUsd;
    expect(95_000_000 / 1_000_000_000).toBeLessThan(0.1);
    expect(groupShare).toBeCloseTo(95_000_000 / 900_000_000, 12);
    expect(groupShare).toBeGreaterThanOrEqual(0.1);
    fixed.safetyScoreV9SupplyAttributionById = { "xaut-tether": attribution! };
    fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["xaut-tether", xautFactSetMeta()]]),
    });
    expect(baseline.assets[0]!.supplyReview?.selectedBridgeRoutes.find((route) =>
      route.deploymentRouteKey.startsWith("representation-group:"))).toMatchObject({
      reviewState: "selected-unresolved",
      supplyShare: expect.closeTo(0.10555555556, 9),
    });
    expect(
      baseline.assets[0]!.economicControlReview?.bridge.status.observationState,
    ).toBe("bounded-unknown");
    const evaluated = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline),
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(evaluated.scoreInput.pillars.control.reasons.map(
      (reason) => reason.code,
    )).toContain("runtime-bridge-materiality-unavailable");
    expect(evaluated.trace.caps).toContainEqual(expect.objectContaining({
      kind: "reason:runtime-bridge-materiality-unavailable",
      limit: 55, source: "evidence", binding: true,
    }));
    expect(evaluated.trace.bindingCap).toMatchObject({
      kind: "reason:runtime-bridge-materiality-unavailable", limit: 55, source: "evidence",
    });
  });

  it("restores the bridge-materiality cap when the wM packet is absent", () => {
    const fixed = wmFixedInput();
    const { compiled, wm } = compileWm(fixed);

    expect(wm.supply.chainDistribution).toBeNull();
    expect(wm.supply.status.observationState).toBe("bounded-unknown");
    expect(wm.gaps).toContainEqual(expect.objectContaining({
      reasonCode: "runtime-bridge-materiality-unavailable",
      responsibility: "producer-failed",
    }));
    expect(wm.evidence).toContainEqual(expect.objectContaining({
      evidenceId: "wm-m0:supply-review-outcome",
      sourceId: "safety-score-v9-supply-review-producer",
      disposition: "rejected",
      rejection: expect.objectContaining({
        code: "supply-review.generation-outcome-missing",
      }),
    }));
    expect(wm.gaps.map((gap) => gap.reasonCode)).toContain(
      "missing-bridge-routes",
    );
    const evaluated = evaluateV9FactSet(
      compiled,
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(
      evaluated.scoreInput.pillars.control.reasons.map((reason) => reason.code),
    ).toContain("runtime-bridge-materiality-unavailable");
    expect(
      evaluated.scoreInput.pillars.control.reasons.find(
        (reason) => reason.code === "runtime-bridge-materiality-unavailable",
      ),
    ).toMatchObject({ responsibility: "producer-failed" });
  });

  it("uses the latest rejected attribution record in hashed outcome diagnostics", () => {
    const fixed = wmFixedInput();
    fixed.supplyAttributionJournalById = {
      "wm-m0": [
        rejectedWmAttributionRecord(fixed, fixed.clockSec - 20, "chain-rpc-unavailable"),
        rejectedWmAttributionRecord(fixed, fixed.clockSec - 10, "deployment-state-unavailable"),
      ],
    };
    const { wm } = compileWm(fixed);
    const outcomeEvidence = wm.evidence.find(
      (evidence) => evidence.evidenceId === "wm-m0:supply-review-outcome",
    )!;

    expect(outcomeEvidence).toMatchObject({
      sourceId: "safety-score-v9-supply-review-producer",
      disposition: "rejected",
      observedAtSec: fixed.clockSec,
      rejection: {
        code: "supply-review.attribution-rpc-rejection",
        rejectedAtSec: fixed.clockSec,
      },
    });
    expect(outcomeEvidence.sourceGenerationId).toMatch(
      /^supply-review-outcome:v1:[a-f0-9]{64}$/,
    );
    expect(outcomeEvidence.sourceGenerationId).toBe(
      `supply-review-outcome:v1:${outcomeEvidence.contentSha256}`,
    );
    const outcomeDigest = () => {
      const current = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([["wm-m0", wmFactSetMeta()]]),
      });
      return compileSafetyScoreV9FactSetFromFixedInput(fixed, current).assets[0]!.evidence.find(
        (evidence) => evidence.evidenceId === "wm-m0:supply-review-outcome",
      )!.contentSha256;
    };
    fixed.supplyAttributionJournalById["wm-m0"]!.reverse();
    expect(outcomeDigest()).toBe(outcomeEvidence.contentSha256);
    fixed.supplyAttributionJournalById["wm-m0"]![0] = rejectedWmAttributionRecord(
      fixed, fixed.clockSec - 10, "chain-rpc-unavailable",
    );
    expect(outcomeDigest()).not.toBe(outcomeEvidence.contentSha256);
  });

  it("persists null-review outcome ownership and diagnostics for each integration and producer state", () => {
    const cases = [
      {
        name: "missing-profile",
        extension: { bridge: "missing" as const },
        responsibility: "integration-missing" as const,
        observationState: "bounded-unknown" as const,
      },
      {
        name: "ambiguous-route-join",
        extension: { bridge: "required" as const },
        responsibility: "integration-missing" as const,
        observationState: "bounded-unknown" as const,
      },
      {
        name: "stale-review",
        extension: { bridge: "required" as const, chainSupplyObservedAtSec: AS_OF_SEC - 501 },
        responsibility: "producer-failed" as const,
        observationState: "stale" as const,
      },
    ];
    for (const { name, extension: extensionCase, responsibility, observationState } of cases) {
      const fixed = exactFixedInput();
      const alpha = compileSafetyScoreV9FactSetFromFixedInput(
        fixed, nullSupplyReviewExtension(extensionCase),
      ).assets[0]!;
      const outcomeEvidence = alpha.evidence.find(
        (evidence) => evidence.evidenceId === "alpha:supply-review-outcome");
      const materialityGap = alpha.gaps.find(
        (gap) => gap.reasonCode === "runtime-bridge-materiality-unavailable");
      expect(outcomeEvidence, name).toMatchObject({
        sourceId: "safety-score-v9-supply-review-producer",
        disposition: "rejected",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceGenerationId: expect.stringMatching(/^supply-review-outcome:v1:[a-f0-9]{64}$/),
        rejection: { code: `supply-review.${name}`, rejectedAtSec: fixed.clockSec },
      });
      expect(outcomeEvidence!.sourceGenerationId).toBe(
        `supply-review-outcome:v1:${outcomeEvidence!.contentSha256}`);
      expect(alpha.supply.status).toMatchObject({
        observationState,
        evidenceRefIds: ["alpha:chain-supply", "alpha:supply-review-outcome"],
      });
      expect(materialityGap).toMatchObject({
        ownerDomain: "control",
        responsibility,
        observationState,
        evidenceRefIds: ["alpha:chain-supply", "alpha:supply-review-outcome"],
      });
      expect(alpha.supply.selectedBridgeRoutes).toEqual([]);
    }
  });

  it("keeps a null supply review known when bridge applicability is explicitly not applicable", () => {
    const fixed = exactFixedInput();
    const alpha = compileSafetyScoreV9FactSetFromFixedInput(
      fixed,
      nullSupplyReviewExtension({ bridge: "not-applicable" }),
    ).assets[0]!;

    expect(alpha.supply.status).toMatchObject({
      observationState: "known",
      evidenceRefIds: ["alpha:chain-supply"],
    });
    expect(alpha.evidence).not.toContainEqual(
      expect.objectContaining({ evidenceId: "alpha:supply-review-outcome" }),
    );
    expect(alpha.gaps).not.toContainEqual(
      expect.objectContaining({ reasonCode: "runtime-bridge-materiality-unavailable" }),
    );
  });

  it("keeps supply missing when neither per-chain rows nor a positive aggregate bucket exist", () => {
    const absent = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ chainSupplyByChain: {} }), extension())
      .assets[0]!.supply;
    expect(absent.status.observationState).not.toBe("known");
    expect(absent.circulatingUsd).toBeNull();
    expect(absent.sourceKind).toBe("usd-denominated-circulating");
    expect(absent.chainDistribution).toBeNull();

    const zero = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ chainSupplyByChain: {}, aggregateCirculating: { peggedUSD: 0 } }),
      extension(),
    ).assets[0]!.supply;
    expect(zero.status.observationState).not.toBe("known");
    expect(zero.circulatingUsd).toBeNull();
    expect(zero.sourceKind).toBe("usd-denominated-circulating");
  });

  it("ages aggregate supply against the supplemental carry-forward ceiling, not the chain-supply cron window", () => {
    const supplyObservedAtSec = AS_OF_SEC - 4_000;
    const fixed = exactFixedInput({
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 4_000_000 },
      supplyObservedAtSec,
    });

    const alpha = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension()).assets[0]!;
    const evidence = alpha.evidence.find((entry) => entry.evidenceId === "alpha:aggregate-supply")!;
    expect(evidence.freshness.maxAgeSec).toBe(7 * 86400);
    expect(evidence.observedAtSec).toBe(supplyObservedAtSec);
    expect(evidence.freshness.ageSec).toBe(4_000);
    expect(evidence.freshness.state).toBe("current");
    expect(alpha.supply.status.observationState).toBe("known");
  });

  it("leaves chain-attributed supply untouched when per-chain rows are present", () => {
    const withoutAggregate = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), extension()).assets[0]!
      .supply;
    const withAggregate = compileSafetyScoreV9FactSetFromFixedInput(
      exactFixedInput({ aggregateCirculating: { peggedUSD: 999_000_000 } }),
      extension(),
    ).assets[0]!.supply;

    expect(withoutAggregate.sourceKind).toBe("usd-denominated-circulating");
    expect(withoutAggregate.circulatingUsd).toBe(10_000_000);
    expect(withoutAggregate.chainDistribution).toEqual({
      chains: [{ chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
      unattributedSupplyUsd: 0,
      unattributedSupplyShare: 0,
    });
    expect(withAggregate).toEqual(withoutAggregate);
  });

});
