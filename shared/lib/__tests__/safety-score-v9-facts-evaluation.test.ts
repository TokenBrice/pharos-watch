import { describe, expect, it } from "vitest";
import {
  AS_OF_SEC,
  SOURCE_FINGERPRINTS,
  V9_CANDIDATE_POLICY_V1,
  canonicalV9DependencyEdgeKey,
  compileNativeV3FactSet,
  compileV9FactSetV2,
  compileV9FactSetV3,
  createV9EvidenceReference,
  createV9FactStatus,
  createV9FactGap,
  createV9FactGapV3,
  evaluateV9FactSet,
  knownStatus,
  minimalAsset,
  projectV9ExitEvaluationRoute,
  requiredV9Applicability,
  coreFixture,
  resolveV9DistinctExitCapacity,
} from "./safety-score-v9-facts.fixture-support";
import type { V9AssetFactsV2, V9AssetFactsV3 } from "./safety-score-v9-facts.fixture-support";

describe("Safety Score v9 fact evaluation", () => {
  it("attributes a missing parent score to the parent's causal NR owner", () => {
    const input = coreFixture();
    const parent = input.assets.find((asset) => asset.assetId === "gamma")! as unknown as V9AssetFactsV2;
    const grandparent = minimalAsset("delta");
    const grandparentFacts = grandparent as unknown as V9AssetFactsV2;
    const parentGap = createV9FactGap({
      gapId: "gamma:gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The mechanism archetype is unresolved.",
    });
    const grandparentGap = createV9FactGap({
      gapId: "delta:gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The upstream mechanism archetype is unresolved.",
    });
    parent.archetype = "unresolved";
    parent.gaps = [parentGap];
    parent.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [parentGap.gapId],
      }),
      review: null,
    };
    parent.dependencies = {
      status: knownStatus(),
      sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
      source: "manual",
      baseSource: "manual",
      dependencyFromLive: false,
      mappedLiveReserveWeight: null,
      fallbackReason: null,
      edges: [
        {
          edgeKey: canonicalV9DependencyEdgeKey("mechanism", "delta"),
          upstreamAssetId: "delta",
          dependencyType: "mechanism",
          pathKind: "serial-dependency",
          weight: 1,
          economicRole: "serial-claim",
          evidenceRefIds: ["evidence:base"],
          failureDomains: [
            { kind: "mint-control", key: "mechanism:delta" },
          ],
        },
      ],
      diagnostics: {
        graphState: "valid",
        issueCodes: [],
        sccMemberAssetIds: [],
      },
    };
    grandparentFacts.archetype = "unresolved";
    grandparentFacts.gaps = [grandparentGap];
    grandparentFacts.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [grandparentGap.gapId],
      }),
      review: null,
    };
    input.assets.push(grandparent);
    input.activeAssetIds.push("delta");

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    const missingParentReasons = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.dependencyReasons.filter(
        (reason) => reason.code === "missing-parent-score",
      );
    expect(
      missingParentReasons.map((reason) => reason.responsibility),
    ).toContain("method-unsupported");
    expect(missingParentReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path:
            "dependency:serial:gamma:cause:asset%3Amissing-pillar%3Apillars.backing",
        }),
        expect.objectContaining({
          path:
            "dependency:serial:gamma:cause:asset%3Adelta%3Amissing-pillar%3Apillars.backing",
        }),
      ]),
    );
  });
  it("attributes a derived oracle reason to the exact reviewed disclosure gap", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const alpha = core.assets.find(
      (asset) => asset.assetId === "alpha",
    ) as V9AssetFactsV3;
    const gap = createV9FactGapV3({
      gapId: "alpha:gap:economic-control:oracle",
      reasonCode: "missing-oracle-profile",
      ownerDomain: "control",
      policyRuleId: "control.oracle.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "economic-control:oracle",
      },
      message: "The issuer review does not disclose a complete oracle profile.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    alpha.gaps.push(gap);
    alpha.economicControlReview.oracle = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("control.oracle.review"),
        observationState: "bounded-unknown",
        evidenceRefIds: ["evidence:base"],
        gapIds: [gap.gapId],
      }),
      tier: null,
      branches: [],
    };

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const reasons = evaluated.assets.find(
      (asset) => asset.assetId === "alpha",
    )!.scoreInput.pillars.control.reasons;

    expect(reasons).toContainEqual(
      expect.objectContaining({
        code: "incomplete-oracle-liquidation-branch",
        path:
          "control:oracle:cause:alpha%3Agap%3Aeconomic-control%3Aoracle",
        responsibility: "issuer-undisclosed",
      }),
    );
    expect(
      reasons.some(
        (reason) =>
          reason.code === "incomplete-oracle-liquidation-branch" &&
          reason.responsibility === "integration-missing",
      ),
    ).toBe(false);
  });
  it("scopes a control-specific reason before considering aggregate control gaps", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const alpha = core.assets.find(
      (asset) => asset.assetId === "alpha",
    ) as V9AssetFactsV3;
    const admin = alpha.controls.find(
      (control) => control.controlKey === "control:admin",
    )!;
    admin.controlKind = "governance";
    const controlGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-control:admin",
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "control.deployment.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "control:control:admin",
      },
      message: "The issuer has not disclosed the admin control semantics.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    const aggregateGap = createV9FactGapV3({
      gapId: "alpha:gap:deployment-controls",
      reasonCode: "unresolved-control-identity",
      ownerDomain: "control",
      policyRuleId: "control.inventory.review",
      observationState: "bounded-unknown",
      path: {
        kind: "local-component",
        componentKey: "deployment-controls",
      },
      message: "The producer cannot reconcile the aggregate control inventory.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "producer-failed",
    });
    alpha.gaps.push(controlGap, aggregateGap);
    admin.status = createV9FactStatus({
      applicability: requiredV9Applicability("control.deployment.review"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [controlGap.gapId],
    });
    alpha.controlStatus = createV9FactStatus({
      applicability: requiredV9Applicability("control.inventory.review"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [aggregateGap.gapId],
    });

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const controlSpecific = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.control.reasons.filter(
        (reason) =>
          reason.code === "unresolved-control-identity" &&
          reason.path ===
            "control:control:control:admin:cause:alpha%3Agap%3Adeployment-control%3Aadmin",
      );

    expect(controlSpecific).toHaveLength(1);
    expect(controlSpecific[0]!.responsibility).toBe("issuer-undisclosed");
  });
  it("keeps mixed upstream backing owners on distinct causal score paths", () => {
    const native = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _digest, ...core } = native;
    const beta = core.assets.find(
      (asset) => asset.assetId === "beta",
    ) as V9AssetFactsV3;
    const issuerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:z-issuer",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: {
        kind: "local-component",
        componentKey: "mechanism-archetype:issuer",
      },
      message: "The issuer has not disclosed the mechanism archetype.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "issuer-undisclosed",
    });
    const producerGap = createV9FactGapV3({
      gapId: "beta:gap:mechanism-archetype:a-producer",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: {
        kind: "local-component",
        componentKey: "mechanism-archetype:producer",
      },
      message: "The current producer capture cannot resolve the mechanism archetype.",
      evidenceRefIds: ["evidence:base"],
      responsibility: "producer-failed",
    });
    beta.archetype = "unresolved";
    beta.gaps = [issuerGap, producerGap];
    beta.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        evidenceRefIds: ["evidence:base"],
        gapIds: [issuerGap.gapId, producerGap.gapId],
      }),
      review: null,
    };

    const singleRootCore = structuredClone(core);
    const singleRootBeta = singleRootCore.assets.find(
      (asset) => asset.assetId === "beta",
    ) as V9AssetFactsV3;
    singleRootBeta.gaps = [issuerGap];
    singleRootBeta.mechanismRiskReview.status = createV9FactStatus({
      applicability: requiredV9Applicability("backing.archetype.review"),
      observationState: "missing",
      evidenceRefIds: ["evidence:base"],
      gapIds: [issuerGap.gapId],
    });
    const singleRootEvaluation = evaluateV9FactSet(
      compileV9FactSetV3(singleRootCore),
      V9_CANDIDATE_POLICY_V1,
    );
    const singleRootReasons = singleRootEvaluation.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.backing.reasons.filter(
        (reason) => reason.code === "material-dependency-unavailable",
      );
    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    );
    const reasons = evaluated.assets
      .find((asset) => asset.assetId === "alpha")!
      .scoreInput.pillars.backing.reasons.filter(
        (reason) => reason.code === "material-dependency-unavailable",
      );
    const singleDirectIssuerReason = singleRootEvaluation.assets
      .find((asset) => asset.assetId === "beta")!
      .scoreInput.pillars.backing.reasons.find(
        (reason) =>
          reason.code === "missing-archetype" &&
          reason.responsibility === "issuer-undisclosed",
      );
    const mixedDirectIssuerReason = evaluated.assets
      .find((asset) => asset.assetId === "beta")!
      .scoreInput.pillars.backing.reasons.find(
        (reason) =>
          reason.code === "missing-archetype" &&
          reason.responsibility === "issuer-undisclosed",
      );

    const singleIssuerReason = singleRootReasons.find(
      (reason) => reason.responsibility === "issuer-undisclosed",
    );
    const mixedIssuerReason = reasons.find(
      (reason) => reason.responsibility === "issuer-undisclosed",
    );
    expect(singleIssuerReason?.path).toContain(
      ":cause:upstream%3Abeta%3Amissing-archetype",
    );
    expect(mixedIssuerReason?.path).toBe(singleIssuerReason?.path);
    expect(mixedDirectIssuerReason?.path).toBe(singleDirectIssuerReason?.path);
    expect(reasons.map((reason) => reason.responsibility)).toEqual(
      expect.arrayContaining(["issuer-undisclosed", "producer-failed"]),
    );
    expect(new Set(reasons.map((reason) => reason.path)).size).toBe(2);
    expect(
      reasons.some((reason) => reason.path.includes(":cause:upstream%3Abeta%3A")),
    ).toBe(true);
  });
  it("inherits verified live wrapper backing monotonically without escaping the parent cap", () => {
    const evaluateWithParentQuality = (quality: "adequate" | "strong", parentWeight = 1) => {
      const input = coreFixture();
      const child = input.assets[1]! as unknown as V9AssetFactsV2;
      const parent = input.assets[2]! as unknown as V9AssetFactsV2;
      child.assetId = "child";
      parent.assetId = "parent";
      child.variantKind = "savings-passthrough";
      child.reserveStatus = knownStatus("evidence:base", "backing.wrapper-live-parent");
      child.reserveExposures = [
        {
          exposureKey: "exposure:parent",
          classificationKey: "stablecoin:parent",
          sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
          provenance: "live",
          status: knownStatus("evidence:base", "backing.wrapper-live-parent"),
          name: "Parent stablecoin",
          weight: parentWeight,
          trackedAssetId: parent.assetId,
          assetClass: "protocol-position",
          issuerOrObligorKey: "asset:parent",
          riskFactors: ["counterparty"],
          liquidityHorizon: "immediate",
          maturityDaysMax: null,
          failureDomains: [{ kind: "reserve-issuer", key: "asset:parent" }],
        },
      ];
      child.dependencies = {
        status: knownStatus("evidence:base", "dependencies.wrapper-parent"),
        sourceGenerationId: SOURCE_FINGERPRINTS.liveReserves.generationId,
        source: "variant",
        baseSource: "live-reserve",
        dependencyFromLive: true,
        mappedLiveReserveWeight: parentWeight,
        fallbackReason: null,
        edges: [
          {
            edgeKey: canonicalV9DependencyEdgeKey("wrapper", parent.assetId),
            upstreamAssetId: parent.assetId,
            dependencyType: "wrapper",
            pathKind: "serial-dependency",
            weight: 1,
            economicRole: "serial-claim",
            evidenceRefIds: ["evidence:base"],
            failureDomains: [{ kind: "mint-control", key: "asset:parent" }],
          },
        ],
        diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
      };
      const parentReview = parent.mechanismRiskReview.review;
      if (parentReview === null || parentReview.archetype !== "algorithmic") {
        throw new Error("Expected algorithmic parent fixture");
      }
      for (const component of [
        parentReview.contractionCapacity,
        parentReview.confidenceAndIncentives,
        parentReview.oracleAndControlAssumptions,
        parentReview.emergencyRecovery,
        parentReview.lossRecovery,
      ]) {
        component.quality = quality;
      }
      input.activeAssetIds = [child.assetId, parent.assetId];
      input.assets = [child as never, parent as never];

      const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
      return {
        child: evaluated.assets.find((asset) => asset.assetId === child.assetId)!,
        parent: evaluated.assets.find((asset) => asset.assetId === parent.assetId)!,
      };
    };

    const adequate = evaluateWithParentQuality("adequate");
    const strong = evaluateWithParentQuality("strong");
    const belowThreshold = evaluateWithParentQuality("strong", 0.98);
    for (const result of [adequate, strong]) {
      expect(result.child.backing.score).toBeCloseTo(result.parent.backing.score!, 12);
      expect(result.child.backing.contributions).toContainEqual(
        expect.objectContaining({
          componentKey: "reserve:inherited-backing:parent",
          observationState: "known",
          provenance: "live",
        }),
      );
      expect(result.child.backing.contributions.some((entry) => entry.source === "mechanism")).toBe(false);
      expect(result.child.trace.finalScore).toBeLessThanOrEqual(result.parent.trace.finalScore!);
    }
    expect(strong.child.backing.score!).toBeGreaterThan(adequate.child.backing.score!);
    expect(
      belowThreshold.child.backing.contributions.some((entry) =>
        entry.componentKey.startsWith("reserve:inherited-backing:"),
      ),
    ).toBe(false);
    expect(belowThreshold.child.backing.contributions.some((entry) => entry.source === "mechanism")).toBe(true);
  });
  it("deduplicates overlapping DEX physical resources before applying common-mode materiality", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    const delta = structuredClone(alpha);
    delta.assetId = "delta";
    input.activeAssetIds.push(delta.assetId);
    input.assets.push(delta as never);

    for (const asset of [alpha, delta]) {
      const primary = asset.exitRoutes.find((route) => route.routeId === "amm-main")!;
      primary.capacityCurve = primary.capacityCurve.map((point) => ({
        ...point,
        executableUsd: 30_000,
        completionRatio: 30_000 / point.requestedNotionalUsd,
      }));
    }

    const primary = alpha.exitRoutes.find((route) => route.routeId === "amm-main")!;
    const projected = projectV9ExitEvaluationRoute(primary);
    const overlappingRoute = (routeKey: string, executableUsd: number, physicalResourceKeys: string[]) => ({
      ...projected,
      routeKey,
      physicalResourceKeys,
      capacityCurve: projected.capacityCurve.map((point) => {
        const executableAtPoint = Math.min(executableUsd, point.requestedNotionalUsd);
        return {
          ...point,
          executableUsd: executableAtPoint,
          completionRatio: executableAtPoint / point.requestedNotionalUsd,
        };
      }),
    });
    expect(
      resolveV9DistinctExitCapacity(
        [
          overlappingRoute("route:a", 20_000, ["resource:a"]),
          overlappingRoute("route:b", 30_000, ["resource:a", "resource:b"]),
          overlappingRoute("route:c", 40_000, ["resource:b"]),
        ],
        {
          requestedNotionalUsd: 1_000_000,
          maxCostBps: 200,
          comparisonWindowSec: 300,
          rawSupplyRequestUsd: 1_000_000,
        },
        V9_CANDIDATE_POLICY_V1,
      ).valuedExecutableUsd,
    ).toBe(40_000);

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    for (const assetId of ["alpha", "delta"]) {
      const signal = evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((candidate) =>
          candidate.failureDomainKeys.includes("dex-protocol:dex:fixture"),
        );
      expect(signal).toMatchObject({ kind: "critical-dependency", severity: "low" });
    }
  });
  it("qualifies DEX common-mode groups with score-bearing routes only", () => {
    const evaluateSharedDex = (alphaEligible: boolean, deltaEligible: boolean) => {
      const input = coreFixture();
      const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
      const delta = structuredClone(alpha);
      delta.assetId = "delta";
      input.activeAssetIds.push(delta.assetId);
      input.assets.push(delta as never);
      for (const [asset, eligible] of [
        [alpha, alphaEligible],
        [delta, deltaEligible],
      ] as const) {
        if (eligible) continue;
        const route = asset.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
        route.coverageClass = "diagnostic";
        route.scoreEligible = false;
      }
      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    };
    const dexSignal = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes("dex-protocol:dex:fixture"),
        );

    const diagnosticOnly = evaluateSharedDex(false, false);
    expect(dexSignal(diagnosticOnly, "alpha")).toBeUndefined();
    expect(dexSignal(diagnosticOnly, "delta")).toBeUndefined();

    const oneEligible = evaluateSharedDex(true, false);
    expect(dexSignal(oneEligible, "alpha")).toBeUndefined();
    expect(dexSignal(oneEligible, "delta")).toBeUndefined();

    const twoEligible = evaluateSharedDex(true, true);
    expect(dexSignal(twoEligible, "alpha")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(dexSignal(twoEligible, "delta")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
  });
  it("joins dependency-owned mint-control groups through asset issuer identity", () => {
    const evaluateSharedMint = (betaIssuer: string | null, gammaIssuer: string | null) => {
      const input = coreFixture();
      const beta = input.assets[1]! as unknown as V9AssetFactsV2;
      const gamma = input.assets[2]! as unknown as V9AssetFactsV2;
      for (const [asset, issuer] of [
        [beta, betaIssuer],
        [gamma, gammaIssuer],
      ] as const) {
        asset.assetIssuerKey = issuer;
        asset.dependencies = {
          status: knownStatus(),
          sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
          source: "manual",
          baseSource: "manual",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [
            {
              edgeKey: canonicalV9DependencyEdgeKey("mechanism", "alpha"),
              upstreamAssetId: "alpha",
              dependencyType: "mechanism",
              pathKind: "serial-dependency",
              weight: 1,
              economicRole: "serial-claim",
              evidenceRefIds: ["evidence:base"],
              failureDomains: [{ kind: "mint-control", key: "shared:dependency-minter" }],
            },
          ],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        };
      }
      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    };
    const signal = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((candidate) =>
          candidate.failureDomainKeys.includes("mint-control:shared:dependency-minter"),
        );

    const sameIssuer = evaluateSharedMint("issuer:shared", "issuer:shared");
    expect(signal(sameIssuer, "beta")).toMatchObject({ severity: "low" });
    expect(signal(sameIssuer, "gamma")).toMatchObject({ severity: "low" });

    const crossIssuer = evaluateSharedMint("issuer:shared", "issuer:other");
    expect(signal(crossIssuer, "beta")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(signal(crossIssuer, "gamma")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });

    const unresolved = evaluateSharedMint("issuer:shared", null);
    expect(signal(unresolved, "beta")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
    expect(signal(unresolved, "gamma")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
  });
  it("keeps a shared upgrade-control ceiling adverse when one member is bounded-unknown", () => {
    const evaluateSharedUpgrade = (boundedUnknownAssetId: string | null) => {
      const input = coreFixture();
      const assets = input.assets as unknown as V9AssetFactsV2[];
      const controlTemplate = structuredClone(
        assets[0]!.controls.find((control) => control.controlKey === "control:admin")!,
      );
      const sharedDomain = { kind: "upgrade-control" as const, key: "platform:fixture" };

      for (const asset of assets) {
        asset.assetIssuerKey = `issuer:${asset.assetId}`;
        const controlKey = `control:shared-upgrade:${asset.assetId}`;
        const deploymentKey = `deployment:${asset.assetId}`;
        const boundedGapId = `${asset.assetId}:gap:shared-upgrade-bounded`;
        const status =
          asset.assetId === boundedUnknownAssetId
            ? createV9FactStatus({
                applicability: requiredV9Applicability("control.upgrade.shared"),
                observationState: "bounded-unknown",
                evidenceRefIds: ["evidence:base"],
                gapIds: [boundedGapId],
              })
            : knownStatus("evidence:base", "control.upgrade.shared");
        if (asset.assetId === boundedUnknownAssetId) {
          asset.gaps.push(
            createV9FactGap({
              gapId: boundedGapId,
              reasonCode: "unknown-upgrade-authority",
              ownerDomain: "control",
              policyRuleId: "control.upgrade.shared",
              observationState: "bounded-unknown",
              path: { kind: "deployment-control", deploymentKey, controlKey },
              message: "The shared upgrade authority was re-verified, but its custody is not established.",
              evidenceRefIds: ["evidence:base"],
            }),
          );
        }
        const control = {
          ...controlTemplate,
          controlKey,
          deploymentKey,
          status,
          failureDomains: [sharedDomain],
          ...(asset.assetId === boundedUnknownAssetId
            ? {
                authority: {
                  authorityKey: `programdata:${asset.assetId}`,
                  model: "unknown" as const,
                  threshold: null,
                },
                capSemantics: { kind: "unknown" as const, bound: null },
                claimImpairment: "unknown" as const,
                economicLossScope: "unknown" as const,
                keyCustody: "unknown" as const,
                modulesOrGuards: "unknown" as const,
              }
            : {}),
        };
        asset.controls.push(control);
        if (asset.assetId !== "alpha") asset.controlStatus = status;
      }

      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    };
    const signal = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets
        .find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((candidate) =>
          candidate.failureDomainKeys.includes("upgrade-control:platform:fixture"),
        );
    const asset = (evaluated: ReturnType<typeof evaluateV9FactSet>, assetId: string) =>
      evaluated.assets.find((candidate) => candidate.assetId === assetId)!;

    const allKnown = evaluateSharedUpgrade(null);
    const degraded = evaluateSharedUpgrade("gamma");
    for (const assetId of ["alpha", "beta"]) {
      expect(signal(degraded, assetId)).toMatchObject({
        severity: "high",
        responsibility: "measured-adverse",
        evidenceConfidence: "high",
      });
      expect(asset(degraded, assetId).trace.caps).toContainEqual(
        expect.objectContaining({
          kind: "signal:critical-dependency:high",
          limit: 64,
        }),
      );
      expect(asset(degraded, assetId).trace.finalScore).toBe(
        asset(allKnown, assetId).trace.finalScore,
      );
      expect(signal(degraded, assetId)?.reason).toContain("bounded-unknown");
    }

    expect(signal(degraded, "gamma")).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
      evidenceConfidence: "low",
    });
    expect(asset(degraded, "gamma").trace.finalScore).toBeLessThanOrEqual(
      asset(allKnown, "gamma").trace.finalScore!,
    );
  });
  it("derives bridge share bounds through reviewed control and deployment joins", () => {
    type BridgeJoinVariant =
      | "known"
      | "aggregate-mismatch"
      | "contradictory-share"
      | "missing-capability"
      | "null-control-share"
      | "same-domain-epsilon-no-row"
      | "same-domain-invalid"
      | "same-domain-null-no-row"
      | "same-domain-zero-no-row"
      | "separate-domain-unjoined"
      | "supply-mismatch"
      | "stale-control"
      | "stale-review"
      | "unmatched"
      | "wrong-kind";
    const evaluateBridgeSignal = (
      targetShare: number,
      variant: BridgeJoinVariant = "known",
      requestedDomainKey = "protocol:fixture-bridge",
    ) => {
      const input = coreFixture();
      const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
      const delta = structuredClone(alpha);
      delta.assetId = "delta";
      input.activeAssetIds.push(delta.assetId);
      input.assets.push(delta as never);

      for (const asset of [alpha, delta]) {
        const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
        const nativeDomain = {
          kind: "bridge-route" as const,
          key: variant === "separate-domain-unjoined" ? "bridge:native" : `native:${asset.assetId}`,
        };
        const controlTemplate = asset.controls.find((control) => control.controlKey === "control:minter")!;
        const targetControl: V9AssetFactsV2["controls"][number] = {
          ...structuredClone(controlTemplate),
          controlKey: "control:bridge-target",
          deploymentKey: "bridge:target",
          controlKind: variant === "wrong-kind" ? "mint" : "bridge",
          scope: "deployment",
          capabilities: variant === "missing-capability" ? [] : ["bridge-mint"],
          materialSupplyShare:
            variant === "null-control-share" ? null : variant === "contradictory-share" ? 1 : targetShare,
          failureDomains: [targetDomain],
        };
        const nativeControl: V9AssetFactsV2["controls"][number] = {
          ...structuredClone(controlTemplate),
          controlKey: "control:bridge-native",
          deploymentKey: "bridge:native",
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          materialSupplyShare: 1 - targetShare,
          failureDomains: [nativeDomain],
        };
        const sameDomainMissingRow = [
          "same-domain-epsilon-no-row",
          "same-domain-invalid",
          "same-domain-null-no-row",
          "same-domain-zero-no-row",
        ].includes(variant);
        const invalidSameDomainControl: V9AssetFactsV2["controls"][number] | null = sameDomainMissingRow
          ? {
              ...structuredClone(controlTemplate),
              controlKey: "control:bridge-invalid",
              deploymentKey: "bridge:invalid",
              controlKind: "bridge",
              scope: "deployment",
              capabilities: ["bridge-mint"],
              materialSupplyShare:
                variant === "same-domain-zero-no-row"
                  ? 0
                  : variant === "same-domain-null-no-row"
                    ? null
                    : variant === "same-domain-epsilon-no-row"
                      ? Number.EPSILON
                      : targetShare,
              failureDomains: [targetDomain],
            }
          : null;
        if (variant === "stale-control") {
          const staleEvidence = createV9EvidenceReference(
            {
              evidenceId: `evidence:stale-bridge-control:${asset.assetId}`,
              sourceId: "bridge-control-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
              disposition: "published",
              observedAtSec: 600,
              publishedAtSec: 610,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          );
          const staleGap = createV9FactGap({
            gapId: `gap:stale-bridge-control:${asset.assetId}`,
            reasonCode: "selected-bridge-route-unresolved",
            ownerDomain: "control",
            policyRuleId: "control.bridge.current",
            observationState: "stale",
            path: {
              kind: "deployment-control",
              deploymentKey: targetControl.deploymentKey,
              controlKey: targetControl.controlKey,
            },
            message: "The bridge control review is stale.",
            evidenceRefIds: [staleEvidence.evidenceId],
          });
          asset.evidence.push(staleEvidence);
          asset.gaps.push(staleGap);
          targetControl.status = createV9FactStatus({
            applicability: requiredV9Applicability("control.bridge.current"),
            observationState: "stale",
            evidenceRefIds: [staleEvidence.evidenceId],
            gapIds: [staleGap.gapId],
          });
        }
        asset.controls.push(
          targetControl,
          ...(variant === "separate-domain-unjoined" ? [] : [nativeControl]),
          ...(invalidSameDomainControl === null ? [] : [invalidSameDomainControl]),
        );
        const targetUsesLowRiskTier = sameDomainMissingRow || variant === "separate-domain-unjoined";
        asset.economicControlReview.bridge = {
          status: knownStatus("evidence:base", "control.bridge.review"),
          routes: [
            {
              controlKey: targetControl.controlKey,
              tier: targetUsesLowRiskTier ? "external-validated-network" : "opaque-or-unknown",
            },
            ...(variant === "separate-domain-unjoined"
              ? []
              : [{ controlKey: nativeControl.controlKey, tier: "single-chain-or-native" as const }]),
            ...(invalidSameDomainControl === null
              ? []
              : [{ controlKey: invalidSameDomainControl.controlKey, tier: "canonical-rollup-bridge" as const }]),
          ],
        };
        if (variant === "stale-review") {
          const staleEvidence = createV9EvidenceReference(
            {
              evidenceId: `evidence:stale-bridge-review:${asset.assetId}`,
              sourceId: "bridge-review-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
              disposition: "published",
              observedAtSec: 600,
              publishedAtSec: 610,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          );
          const staleGap = createV9FactGap({
            gapId: `gap:stale-bridge-review:${asset.assetId}`,
            reasonCode: "selected-bridge-route-unresolved",
            ownerDomain: "control",
            policyRuleId: "control.bridge.review.current",
            observationState: "stale",
            path: {
              kind: "deployment-control",
              deploymentKey: targetControl.deploymentKey,
              controlKey: targetControl.controlKey,
            },
            message: "The bridge review envelope is stale.",
            evidenceRefIds: [staleEvidence.evidenceId],
          });
          asset.evidence.push(staleEvidence);
          asset.gaps.push(staleGap);
          asset.economicControlReview.bridge.status = createV9FactStatus({
            applicability: requiredV9Applicability("control.bridge.review.current"),
            observationState: "stale",
            evidenceRefIds: [staleEvidence.evidenceId],
            gapIds: [staleGap.gapId],
          });
        }
        asset.supply.selectedBridgeRoutes = [
          {
            deploymentRouteKey: variant === "unmatched" ? "bridge:unmatched" : targetControl.deploymentKey,
            supplyUsd: (variant === "supply-mismatch" ? 9_000_000 : 10_000_000) * targetShare,
            supplyShare: targetShare,
            reviewState: "selected-reviewed",
          },
          {
            deploymentRouteKey: nativeControl.deploymentKey,
            supplyUsd: 10_000_000 * (1 - targetShare),
            supplyShare: 1 - targetShare,
            reviewState: "selected-reviewed",
          },
        ];
        asset.supply.selectedRouteSupplyShare = variant === "aggregate-mismatch" ? 0.99 : 1;
        asset.supply.unknownRouteSupplyShare = 0;
        asset.supply.unreviewedRouteSupplyShare = 0;
        asset.supply.failureDomains.push(targetDomain, nativeDomain);
      }

      const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
      return evaluated.assets
        .find((asset) => asset.assetId === "alpha")!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes(`bridge-route:${requestedDomainKey}`),
        )!;
    };
    const evaluateBridgeSeverity = (
      targetShare: number,
      variant: BridgeJoinVariant = "known",
      requestedDomainKey = "protocol:fixture-bridge",
    ) => evaluateBridgeSignal(targetShare, variant, requestedDomainKey).severity;

    expect(evaluateBridgeSeverity(0.0999)).toBe("low");
    expect(evaluateBridgeSeverity(0.1)).toBe("moderate");
    expect(evaluateBridgeSeverity(0.2499)).toBe("moderate");
    expect(evaluateBridgeSeverity(0.25)).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "aggregate-mismatch")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "contradictory-share")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "missing-capability")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "null-control-share")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-zero-no-row")).toBe("low");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-null-no-row")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-epsilon-no-row")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "same-domain-invalid")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "separate-domain-unjoined")).toBe("low");
    expect(evaluateBridgeSeverity(0.0499, "separate-domain-unjoined", "bridge:native")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "supply-mismatch")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "unmatched")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "wrong-kind")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "stale-control")).toBe("high");
    expect(evaluateBridgeSeverity(0.0499, "stale-review")).toBe("high");
    expect(evaluateBridgeSignal(0.25)).toMatchObject({
      severity: "high",
      responsibility: "measured-adverse",
    });
    expect(evaluateBridgeSignal(0.0499, "aggregate-mismatch")).toMatchObject({
      severity: "high",
      responsibility: "integration-missing",
    });
  });
  it("does not treat a control-only bridge domain as exact supply attribution", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    const delta = structuredClone(alpha);
    delta.assetId = "delta";
    input.activeAssetIds.push(delta.assetId);
    input.assets.push(delta as never);

    for (const asset of [alpha, delta]) {
      const targetDomain = { kind: "bridge-route" as const, key: "protocol:fixture-bridge" };
      const controlOnlyDomain = { kind: "bridge-route" as const, key: "bridge:native" };
      const controlTemplate = asset.controls.find((control) => control.controlKey === "control:minter")!;
      const targetControl: V9AssetFactsV2["controls"][number] = {
        ...structuredClone(controlTemplate),
        controlKey: "control:bridge-target",
        deploymentKey: "bridge:target",
        controlKind: "bridge",
        scope: "deployment",
        capabilities: ["bridge-mint"],
        materialSupplyShare: 0.0499,
        failureDomains: [targetDomain],
      };
      const decoyControl: V9AssetFactsV2["controls"][number] = {
        ...structuredClone(controlTemplate),
        controlKey: "control:bridge-decoy",
        deploymentKey: "bridge:decoy",
        controlKind: "bridge",
        scope: "deployment",
        capabilities: ["bridge-mint"],
        materialSupplyShare: 0,
        failureDomains: [controlOnlyDomain],
      };
      asset.controls.push(targetControl, decoyControl);
      asset.economicControlReview.bridge = {
        status: knownStatus("evidence:base", "control.bridge.review"),
        routes: [
          { controlKey: targetControl.controlKey, tier: "external-validated-network" },
          { controlKey: decoyControl.controlKey, tier: "canonical-rollup-bridge" },
        ],
      };
      asset.supply.selectedBridgeRoutes = [
        {
          deploymentRouteKey: targetControl.deploymentKey,
          supplyUsd: 499_000,
          supplyShare: 0.0499,
          reviewState: "selected-reviewed",
        },
        {
          deploymentRouteKey: "bridge:native",
          supplyUsd: 9_501_000,
          supplyShare: 0.9501,
          reviewState: "selected-reviewed",
        },
      ];
      asset.supply.selectedRouteSupplyShare = 1;
      asset.supply.unknownRouteSupplyShare = 0;
      asset.supply.unreviewedRouteSupplyShare = 0;
      asset.supply.failureDomains.push(targetDomain);
    }

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    for (const assetId of ["alpha", "delta"]) {
      expect(
        evaluated.assets
          .find((asset) => asset.assetId === assetId)!
          .scoreInput.dependencyStructuralSignals.find((signal) =>
            signal.failureDomainKeys.includes("bridge-route:protocol:fixture-bridge"),
          ),
      ).toMatchObject({ severity: "high" });
    }
  });
  it("rejects bridge reviews that reference a missing control before evaluation", () => {
    const input = coreFixture();
    const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
    alpha.economicControlReview.bridge = {
      status: knownStatus("evidence:base", "control.bridge.review"),
      routes: [{ controlKey: "control:missing-bridge", tier: "external-validated-network" }],
    };
    expect(() => compileV9FactSetV2(input)).toThrow(/review references unknown control control:missing-bridge/);
  });
  it("does not turn pillar or diagnostic reasons into a global limited-evidence cap", () => {
    const pillarInput = coreFixture();
    const pillarAsset = pillarInput.assets[0]! as unknown as V9AssetFactsV2;
    const pillarGap = createV9FactGap({
      gapId: "gap:bounded-mechanism",
      reasonCode: "bounded-mechanism-review",
      ownerDomain: "backing",
      policyRuleId: "backing.mechanism.bounded",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "The assurance component is conservatively bounded.",
      evidenceRefIds: ["evidence:base"],
    });
    pillarAsset.gaps.push(pillarGap);
    const pillarReview = pillarAsset.mechanismRiskReview.review!;
    if (pillarReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    pillarReview.assuranceAndReconciliation = {
      ...pillarReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.mechanism.bounded"),
        observationState: "bounded-unknown",
        evidenceRefIds: ["evidence:base"],
        gapIds: [pillarGap.gapId],
      }),
      quality: null,
    };
    const pillarEvaluated = evaluateV9FactSet(compileNativeV3FactSet(pillarInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(pillarEvaluated.scoreInput.pillars.backing).toMatchObject({
      evidenceLevel: "strong",
      reasons: [expect.objectContaining({ code: "bounded-mechanism-review" })],
    });
    expect(pillarEvaluated.trace.caps.map((cap) => cap.kind)).not.toContain("evidence:limited");

    const diagnosticInput = coreFixture();
    const diagnosticAsset = diagnosticInput.assets[0]! as unknown as V9AssetFactsV2;
    const dexRoute = diagnosticAsset.exitRoutes.find((route) => route.routeId === "amm-main")!;
    const redemptionRoute = diagnosticAsset.exitRoutes.find((route) => route.routeId === "issuer-main")!;
    redemptionRoute.failureDomains.push(dexRoute.failureDomains.find((domain) => domain.kind === "dex-protocol")!);
    const diagnosticEvaluated = evaluateV9FactSet(
      compileNativeV3FactSet(diagnosticInput),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;
    expect(diagnosticEvaluated.exit.reasons).toContain("correlated-exit-routes");
    expect(diagnosticEvaluated.scoreInput.pillars.exit.evidenceLevel).toBe("adequate");
    expect(diagnosticEvaluated.trace.caps.map((cap) => cap.kind)).not.toContain("evidence:limited");
  });
  it("attributes an immaterial score-bearing lower-bound exit instead of withholding its F score", () => {
    const input = coreFixture();
    const alpha = input.assets.find((asset) => asset.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const beta = input.assets.find((asset) => asset.assetId === "beta")! as unknown as V9AssetFactsV2;
    const routeEvidence = alpha.evidence.find((evidence) => evidence.evidenceId === "evidence:route")!;
    const measuredRoute = structuredClone(
      alpha.exitRoutes.find((route) => route.routeId === "amm-main")!,
    );
    measuredRoute.coverageClass = "exact-lower-bound";
    measuredRoute.capacityCurve = measuredRoute.capacityCurve.map((point) => ({
      ...point,
      executableUsd: 1,
      completionRatio: 1 / point.requestedNotionalUsd,
      executionCostBps: point.maxCostBps,
    }));
    beta.evidence.push(routeEvidence);
    beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
    beta.exitRoutes = [measuredRoute];

    const evaluated = evaluateV9FactSet(
      compileNativeV3FactSet(input),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "beta")!;
    const primaryRoute = evaluated.exit.routes.find(
      (route) => route.routeKey === evaluated.exit.primaryRouteKey,
    )!;

    expect(primaryRoute.capsApplied).toContain("immaterial-executable-capacity");
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({
      score: 0,
      adverseAttribution: [
        {
          source: "pillar-score",
          path: `pillar:exit:route:${measuredRoute.routeKey}:capacity`,
          responsibility: "measured-adverse",
        },
      ],
    });
    expect(evaluated.trace.finalGrade).toBe("F");
    expect(evaluated.trace.finalScore).not.toBeNull();
    expect(evaluated.trace.nrReasons).not.toContainEqual(
      expect.objectContaining({ field: "adverseAttribution" }),
    );
    expect(evaluated.trace.adverseAttribution).toContainEqual(
      expect.objectContaining({
        source: "pillar-score",
        path: `pillar:exit:route:${measuredRoute.routeKey}:capacity`,
      }),
    );
  });
  it("attributes a measured-zero discounted redemption instead of relabeling it as unsupported", () => {
    const input = coreFixture();
    const alpha = input.assets.find((asset) => asset.assetId === "alpha")! as unknown as V9AssetFactsV2;
    const beta = input.assets.find((asset) => asset.assetId === "beta")! as unknown as V9AssetFactsV2;
    const routeEvidence = alpha.evidence.find((evidence) => evidence.evidenceId === "evidence:route")!;
    const redemptionRoute = structuredClone(
      alpha.exitRoutes.find((route) => route.routeId === "issuer-main")!,
    );
    redemptionRoute.routeFamily = "protocol-redemption";
    redemptionRoute.scoreEligible = false;
    redemptionRoute.evidenceKind = "live-reserve-state";
    redemptionRoute.coverageClass = "exact-lower-bound";
    redemptionRoute.settlementModel = "queued";
    redemptionRoute.settlementSlaSec = 86_400;
    redemptionRoute.capacityCurve = redemptionRoute.capacityCurve.map((point) => ({
      ...point,
      executableUsd: 0,
      completionRatio: 0,
    }));
    beta.evidence.push(routeEvidence);
    beta.exitStatus = knownStatus(routeEvidence.evidenceId, "exit.portfolio.reviewed");
    beta.exitRoutes = [redemptionRoute];

    const evaluated = evaluateV9FactSet(
      compileNativeV3FactSet(input),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "beta")!;
    const primaryRoute = evaluated.exit.routes.find(
      (route) => route.routeKey === evaluated.exit.primaryRouteKey,
    )!;

    expect(primaryRoute).toMatchObject({
      included: true,
      score: 0,
      capsApplied: expect.arrayContaining(["zero-executable-capacity"]),
    });
    expect(evaluated.exit.reasons).toContain("no-viable-exit-path");
    expect(evaluated.scoreInput.pillars.exit).toMatchObject({
      score: 0,
      reasons: [expect.objectContaining({ responsibility: "measured-adverse" })],
      adverseAttribution: [
        expect.objectContaining({
          source: "pillar-score",
          path: `pillar:exit:route:${redemptionRoute.routeKey}:capacity`,
          responsibility: "measured-adverse",
        }),
      ],
    });
    expect(evaluated.trace.finalGrade).toBe("F");
    expect(evaluated.trace.finalScore).not.toBeNull();
  });
  it("honours each ceiling reason's declared level and keeps NR conditions insufficient", () => {
    const ceilingInput = coreFixture();
    const ceilingAsset = ceilingInput.assets[0]! as unknown as V9AssetFactsV2;
    const staleEvidence = createV9EvidenceReference(
      {
        evidenceId: "evidence:stale-assurance",
        sourceId: "assurance-source",
        sourceGenerationId: "assurance:g1",
        disposition: "published",
        observedAtSec: 600,
        publishedAtSec: 610,
        maxAgeSec: 100,
      },
      AS_OF_SEC,
    );
    const ceilingGap = createV9FactGap({
      gapId: "gap:stale-assurance",
      reasonCode: "missing-latest-assurance-report",
      ownerDomain: "backing",
      policyRuleId: "backing.assurance.current",
      observationState: "stale",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "The latest assurance report is stale.",
      evidenceRefIds: [staleEvidence.evidenceId],
    });
    ceilingAsset.evidence.push(staleEvidence);
    ceilingAsset.gaps.push(ceilingGap);
    const ceilingReview = ceilingAsset.mechanismRiskReview.review!;
    if (ceilingReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    ceilingReview.assuranceAndReconciliation = {
      ...ceilingReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.assurance.current"),
        observationState: "stale",
        evidenceRefIds: [staleEvidence.evidenceId],
        gapIds: [ceilingGap.gapId],
      }),
    };
    const ceilingEvaluated = evaluateV9FactSet(compileNativeV3FactSet(ceilingInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    // `missing-latest-assurance-report` declares `ceilingRule.level: "adequate"`.
    // Flooring every ceiling reason at `limited` made that declaration
    // unreachable, because the implied evidence ceiling of 69 always bound
    // below the reason's own 84. The declared level is now honoured.
    expect(ceilingEvaluated.scoreInput.pillars.backing.evidenceLevel).toBe("adequate");
    expect(ceilingEvaluated.trace.caps.map((cap) => cap.kind)).toContain("evidence:adequate");
    expect(ceilingEvaluated.trace.caps.map((cap) => cap.kind)).not.toContain("evidence:limited");

    // Weakest declared level wins: adding a `limited`-declaring ceiling reason
    // beside the `adequate` one must pull the level back down, otherwise the
    // generalization would silently promote every mixed card.
    const mixedInput = coreFixture();
    const mixedAsset = mixedInput.assets[0]! as unknown as V9AssetFactsV2;
    mixedAsset.evidence.push(staleEvidence);
    mixedAsset.gaps.push(ceilingGap);
    const mixedReview = mixedAsset.mechanismRiskReview.review!;
    if (mixedReview.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
    mixedReview.assuranceAndReconciliation = {
      ...mixedReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.assurance.current"),
        observationState: "stale",
        evidenceRefIds: [staleEvidence.evidenceId],
        gapIds: [ceilingGap.gapId],
      }),
    };
    // `unreviewed-dependency-relationships` declares `limited` and accepts a
    // local-component path, so it can sit beside the `adequate` reason on the
    // same fixture without inventing an exposure.
    const limitedGap = createV9FactGap({
      gapId: "gap:unreviewed-dependency-relationships",
      reasonCode: "unreviewed-dependency-relationships",
      ownerDomain: "dependency",
      policyRuleId: "v9.dependency.relationships",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "assurance-and-reconciliation" },
      message: "Dependency relationships are unreviewed.",
      evidenceRefIds: [staleEvidence.evidenceId],
    });
    mixedAsset.gaps.push(limitedGap);
    mixedReview.assuranceAndReconciliation = {
      ...mixedReview.assuranceAndReconciliation,
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.assurance.current"),
        observationState: "stale",
        evidenceRefIds: [staleEvidence.evidenceId],
        gapIds: [ceilingGap.gapId, limitedGap.gapId],
      }),
    };
    const mixedEvaluated = evaluateV9FactSet(compileNativeV3FactSet(mixedInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(mixedEvaluated.scoreInput.pillars.backing.evidenceLevel).toBe("limited");
    expect(mixedEvaluated.trace.caps.map((cap) => cap.kind)).toContain("evidence:limited");

    const nrInput = coreFixture();
    const nrAsset = nrInput.assets[0]! as unknown as V9AssetFactsV2;
    const nrGap = createV9FactGap({
      gapId: "gap:missing-mechanism-review",
      reasonCode: "missing-pillar-evidence",
      ownerDomain: "backing",
      policyRuleId: "backing.mechanism.required",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-review" },
      message: "The mechanism review is missing.",
    });
    nrAsset.gaps.push(nrGap);
    nrAsset.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.mechanism.required"),
        observationState: "missing",
        gapIds: [nrGap.gapId],
      }),
      review: null,
    };
    const nrEvaluated = evaluateV9FactSet(compileNativeV3FactSet(nrInput), V9_CANDIDATE_POLICY_V1).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(nrEvaluated.scoreInput.pillars.backing.evidenceLevel).toBe("insufficient");
    expect(nrEvaluated.trace.finalScore).toBeNull();
  });
});
