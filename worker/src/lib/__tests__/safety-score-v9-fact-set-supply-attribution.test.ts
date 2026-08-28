/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import wrappedMSource from "@shared/data/stablecoins/coins/wm-m0.json";
import xautMetaSource from "@shared/data/stablecoins/coins/xaut-tether.json";
import wrappedMRiskReview from "@shared/data/stablecoins/domains/risk-review/wm-m0.json";
import xautRiskReview from "@shared/data/stablecoins/domains/risk-review/xaut-tether.json";
import wrappedMMintAuthority from "@shared/data/stablecoins/domains/mint-authority/wm-m0.json";
import xautMintAuthority from "@shared/data/stablecoins/domains/mint-authority/xaut-tether.json";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  V9_CANDIDATE_POLICY_V1,
  loadV9MethodologyPolicy,
} from "@shared/lib/safety-score-v9/policy";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
} from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import {
  deriveXautRepresentationGroupSupplyAttribution,
  XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
} from "../safety-score-v9-xaut-supply-attribution-contract";
import {
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeXautObservation,
  makeV9FixedInput as exactFixedInput,
  v9CoinMaxReviewedAtSec,
  makeV9Extension as extension,
  withV9WmReviewedDeploymentAttribution as withWmReviewedDeploymentAttribution,
} from "../../test-helpers/v9-fixed-input";

// Nine hours past each asset's newest reviewed registry date. Both suites only
// need a clock at or after the committed control/access reviews, so deriving it
// retires the literal that had to be re-pinned every curation pass.
const WM_CLOCK_SEC = v9CoinMaxReviewedAtSec("wm-m0") + 9 * 3_600;
const XAUT_CLOCK_SEC = v9CoinMaxReviewedAtSec("xaut-tether") + 9 * 3_600;

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
    // Summed, never multiplied by price: list circulating is already USD.
    expect(supply.circulatingUsd).toBe(5_000_000);
    expect(supply.referencePriceUsd).toBeNull();
    expect(supply.circulatingUnits).toBeNull();
    // Per-chain attribution genuinely does not exist, so it is not synthesized.
    expect(supply.chainDistribution).toBeNull();
    expect(supply.failureDomains).toEqual([]);
    expect(supply.selectedBridgeRoutes).toEqual([]);
    expect(supply.selectedRouteSupplyShare).toBeNull();
    expect(supply.unknownRouteSupplyShare).toBeNull();
    expect(supply.unreviewedRouteSupplyShare).toBeNull();
  });

  it("compiles exact wM route shares without bridge-materiality uncertainty", () => {
    const clockSec = WM_CLOCK_SEC;
    const fixed = withWmReviewedDeploymentAttribution(
      exactFixedInput({
        assetId: "wm-m0",
        clockSec,
        chainSupplyByChain: {},
        aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
        omitLiveReserve: true,
      }),
    );
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        ["wm-m0", ({
            ...wrappedMSource,
            bridgeRouteRisk: wrappedMRiskReview.bridgeRouteRisk,
            mintAuthority: wrappedMMintAuthority.mintAuthority,
          } as unknown as V9ExtensionRegistryMeta)],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const wm = compiled.assets[0]!;

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
    // At or after the committed xaut-tether control/access review dates
    // (2026-08-08), so the reviewed mint controls are clock-admissible.
    const clockSec = XAUT_CLOCK_SEC;
    const aggregateSupplyUsd = 2_480_000_000;
    const fixed = exactFixedInput({
      assetId: "xaut-tether",
      clockSec,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedGOLD: aggregateSupplyUsd },
      omitLiveReserve: true,
    });
    const attribution =
      deriveXautRepresentationGroupSupplyAttribution({
        aggregateSupplyUsd,
        registryFingerprint: fixed.registryFingerprint,
        scoringClockSec: fixed.clockSec,
        observation: makeXautObservation({
          clockSec,
          // Production-shaped consumer age: finalized-block lag plus the
          // healthy 30-minute capture cadence exceeds the generic 1800s
          // chain-supply window while remaining inside XAUT's explicit hour.
          blockTimeSec: clockSec - 2_800,
          disclosure: {
            sourceTimestampSec: clockSec - 2_900,
            responseSha256: "e".repeat(64),
          },
        }),
      });
    expect(attribution).not.toBeNull();
    fixed.safetyScoreV9SupplyAttributionById = {
      "xaut-tether": attribution!,
    };
    fixed.baseInputGenerationId =
      deriveReportCardsBaseInputGenerationId(fixed);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "xaut-tether",
          ({
            ...xautMetaSource,
            bridgeRouteRisk: xautRiskReview.bridgeRouteRisk,
            mintAuthority: xautMintAuthority.mintAuthority,
          } as unknown as V9ExtensionRegistryMeta),
        ],
      ]),
    });
    const compiled =
      compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const xaut = compiled.assets[0]!;
    const supplyEvidence = xaut.evidence.find(
      (evidence) => evidence.evidenceId === "xaut-tether:chain-supply",
    );
    const groupRow = xaut.supply.selectedBridgeRoutes.find((route) =>
      route.deploymentRouteKey.startsWith("representation-group:"),
    );
    const bridgeControls = xaut.controls.filter(
      (control) => control.controlKind === "bridge",
    );

    expect(xaut.supply.status.observationState).toBe("known");
    expect(supplyEvidence).toMatchObject({
      observedAtSec: clockSec - 2_800,
      freshness: {
        state: "current",
        ageSec: 2_800,
        maxAgeSec: XAUT_SUPPLY_ATTRIBUTION_MAX_AGE_SEC,
      },
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
      chains: [
        {
          chainId: "ethereum",
          supplyShare: expect.closeTo(0.95150186773, 9),
        },
      ],
      unattributedSupplyShare: expect.closeTo(0.04849813227, 9),
    });
    expect(bridgeControls).toHaveLength(1);
    expect(bridgeControls[0]).toMatchObject({
      status: {
        applicability: { state: "required" },
        observationState: "bounded-unknown",
      },
      deploymentKey:
        "representation-group:xaut-tether:xaut0-omnichain",
      capSemantics: { kind: "unbounded" },
      claimImpairment: "unbounded",
      economicLossScope: "deployment",
      materialSupplyShare: expect.closeTo(0.04849813227, 9),
      authority: {
        authorityKey:
          "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
        model: "unknown",
      },
      failureDomains: [
        {
          kind: "bridge-route",
          key: "contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
        },
        {
          kind: "bridge-route",
          key: "protocol:xaut0-omnichain",
        },
      ],
    });
    expect(
      xaut.economicControlReview.bridge.status.observationState,
    ).toBe("known");
    expect(
      bridgeControls.some((control) =>
        attribution!.representationGroup.routeIds.includes(
          control.deploymentKey,
        ),
      ),
    ).toBe(false);
    // The reviewed canonical authority stays partitioned away from the XAUt0
    // group: the onlyOwner mint path on the canonical Ethereum deployment and
    // the separate upgrade-only ProxyAdmin owner (3-of-6 legacy multisig, the
    // exact `upgradeability.controlRef` target) are the only non-bridge controls.
    // Both are deployment-scoped; neither is a global root-claim authority.
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
        // Control identities are content-derived, so compare by authority rather than array order.
        .sort((left, right) => (left.authority?.authorityKey ?? "").localeCompare(right.authority?.authorityKey ?? "")),
    ).toEqual([
      {
        controlKind: "mint",
        scope: "deployment",
        capabilities: ["mint"],
        deploymentKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
        authority: {
          authorityKey:
            "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
          model: "contract",
          threshold: null,
        },
      },
      {
        controlKind: "upgrade",
        scope: "deployment",
        capabilities: ["mint", "upgrade"],
        deploymentKey: "ethereum:0x68749665ff8d2d112fa859aa293f07a622782f38",
        authority: {
          authorityKey:
            "ethereum:0xc6cde7c39eb2f0f0095f41570af89efc2c1ea828",
          model: "multisig",
          threshold: { required: 3, total: 6 },
        },
      },
    ]);

    const evaluated = evaluateV9FactSet(
      compiled,
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    const reasonCodes =
      evaluated.scoreInput.pillars.control.reasons.map(
        (reason) => reason.code,
      );
    expect(reasonCodes).not.toContain(
      "immaterial-unrecognized-chain-pool",
    );
    expect(reasonCodes).not.toContain(
      "material-bridge-supply-unmatched",
    );

    const singleAssetCommonModePolicy = loadV9MethodologyPolicy({
      ...V9_CANDIDATE_POLICY_V1.policy,
      policyId: "safety-score-v9-xaut-common-mode-test",
      semantic: {
        ...V9_CANDIDATE_POLICY_V1.policy.semantic,
        materiality: {
          ...V9_CANDIDATE_POLICY_V1.policy.semantic.materiality,
          commonControlMinAssets: 1,
        },
      },
    });
    const commonModeSignals = evaluateV9FactSet(
      compiled,
      singleAssetCommonModePolicy,
    ).assets[0]!.scoreInput.dependencyStructuralSignals.filter((signal) =>
      signal.failureDomainKeys.some((key) =>
        key.startsWith("bridge-route:"),
      ),
    );
    expect(commonModeSignals).toEqual([
      expect.objectContaining({
        failureDomainKeys: [
          "bridge-route:contract:ethereum:0xb9c2321bb7d0db468f570d10a424d1cc8efd696c",
        ],
        materialSharePct: expect.closeTo(4.849813227, 7),
        severity: "low",
        responsibility: "measured-adverse",
      }),
      expect.objectContaining({
        failureDomainKeys: [
          "bridge-route:protocol:xaut0-omnichain",
        ],
        materialSharePct: expect.closeTo(4.849813227, 7),
        severity: "low",
        responsibility: "measured-adverse",
      }),
    ]);
  });

  it("withholds XAUT when no reconciled V2 supply packet can establish global chain supply", () => {
    const fixed = exactFixedInput({
      assetId: "xaut-tether",
      // At or after the committed 2026-08-08 xaut-tether control review dates.
      clockSec: XAUT_CLOCK_SEC,
      chainSupplyByChain: {},
      omitLiveReserve: true,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "xaut-tether",
          ({
            ...xautMetaSource,
            bridgeRouteRisk: xautRiskReview.bridgeRouteRisk,
            mintAuthority: xautMintAuthority.mintAuthority,
          } as unknown as V9ExtensionRegistryMeta),
        ],
      ]),
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

  it("fails closed when the XAUt0 group reaches the materiality floor", () => {
    // At or after the committed 2026-08-08 xaut-tether control review dates.
    const clockSec = XAUT_CLOCK_SEC;
    const aggregateSupplyUsd = 2_480_000_000;
    const fixed = exactFixedInput({
      assetId: "xaut-tether",
      clockSec,
      liquidityScore: 95,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedGOLD: aggregateSupplyUsd },
    });
    const attribution =
      deriveXautRepresentationGroupSupplyAttribution({
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
            sourceTimestampSec: clockSec - 200,
            responseSha256: "f".repeat(64),
            totalAuthorizedRaw: "1000000000",
            notIssuedRaw: "100000000",
            quarantinedRaw: "0",
          },
        }),
      });
    expect(attribution).not.toBeNull();
    expect(95_000_000 / 1_000_000_000).toBeLessThan(0.1);
    expect(
      attribution!.representationGroup.currentSupplyUsd /
        aggregateSupplyUsd,
    ).toBeCloseTo(95_000_000 / 900_000_000, 12);
    expect(
      attribution!.representationGroup.currentSupplyUsd /
        aggregateSupplyUsd,
    ).toBeGreaterThanOrEqual(0.1);
    fixed.safetyScoreV9SupplyAttributionById = {
      "xaut-tether": attribution!,
    };
    fixed.baseInputGenerationId =
      deriveReportCardsBaseInputGenerationId(fixed);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "xaut-tether",
          ({
            ...xautMetaSource,
            bridgeRouteRisk: xautRiskReview.bridgeRouteRisk,
            mintAuthority: xautMintAuthority.mintAuthority,
          } as unknown as V9ExtensionRegistryMeta),
        ],
      ]),
    });
    expect(
      baseline.assets[0]!.supplyReview?.selectedBridgeRoutes.find((route) =>
        route.deploymentRouteKey.startsWith("representation-group:"),
      ),
    ).toMatchObject({
      reviewState: "selected-unresolved",
      supplyShare: expect.closeTo(0.10555555556, 9),
    });
    expect(
      baseline.assets[0]!.economicControlReview?.bridge.status
        .observationState,
    ).toBe("bounded-unknown");

    const compiled =
      compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const evaluated = evaluateV9FactSet(
      compiled,
      V9_CANDIDATE_POLICY_V1,
    ).assets[0]!;
    expect(
      evaluated.scoreInput.pillars.control.reasons.map(
        (reason) => reason.code,
      ),
    ).toContain("runtime-bridge-materiality-unavailable");
    expect(evaluated.trace.caps).toContainEqual(
      expect.objectContaining({
        kind: "reason:runtime-bridge-materiality-unavailable",
        limit: 55,
        source: "evidence",
        binding: true,
      }),
    );
    expect(evaluated.trace.bindingCap).toMatchObject({
      kind: "reason:runtime-bridge-materiality-unavailable",
      limit: 55,
      source: "evidence",
    });
  });

  it("restores the bridge-materiality cap when the wM packet is absent", () => {
    const fixed = exactFixedInput({
      assetId: "wm-m0",
      clockSec: WM_CLOCK_SEC,
      chainSupplyByChain: {},
      aggregateCirculating: { peggedUSD: 87_020_618.58982982 },
      omitLiveReserve: true,
    });
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        ["wm-m0", ({
            ...wrappedMSource,
            bridgeRouteRisk: wrappedMRiskReview.bridgeRouteRisk,
            mintAuthority: wrappedMMintAuthority.mintAuthority,
          } as unknown as V9ExtensionRegistryMeta)],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const wm = compiled.assets[0]!;

    expect(wm.supply.chainDistribution).toBeNull();
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
    // Carried-forward supply legitimately predates the chain-supply lane's own
    // window (500s in this fixture); it is bounded by the 7-day intake ceiling.
    expect(evidence.freshness.maxAgeSec).toBe(7 * 86400);
    expect(evidence.observedAtSec).toBe(supplyObservedAtSec);
    expect(evidence.freshness.ageSec).toBe(4_000);
    expect(evidence.freshness.state).toBe("current");
    expect(alpha.supply.status.observationState).toBe("known");
  });

  it("leaves chain-attributed supply untouched when per-chain rows are present", () => {
    const withoutAggregate = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput(), extension()).assets[0]!
      .supply;
    // An aggregate bucket that disagrees must not displace real chain attribution.
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
