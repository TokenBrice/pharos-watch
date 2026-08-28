import { describe, expect, it } from "vitest";
import {
  AS_OF_SEC,
  SOURCE_FINGERPRINTS,
  assertExactV9ActiveAssetSet,
  canonicalV9DependencyEdgeKey,
  canonicalV9RouteKey,
  compileV9FactSetV2,
  compileV9FactSetV3,
  createV9EvidenceReference,
  createV9FactGap,
  createV9FactGapV3,
  createV9FactStatus,
  evaluateV9FactSet,
  fullAsset,
  coreFixture,
  compileNativeV3FactSet,
  nativeCompleteEmptyCoreFixture,
  knownStatus,
  optionalExitV9Path,
  parseCompiledV9FactSetV2,
  readCompiledV9FactSetForEvaluation,
  requiredV9Applicability,
  stableJsonStringifyV1,
  V9_CANDIDATE_POLICY_V1,
} from "./safety-score-v9-facts.fixture-support";
import type { V9AssetFactsV2, V9AssetFactsV3 } from "./safety-score-v9-facts.fixture-support";

describe("Safety Score v9 fact compilation and upgrades", () => {
  it("defaults retained v2 fact routes without modeled confidence to low", () => {
    const retained = structuredClone(coreFixture());
    const route = retained.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
    delete (route as unknown as Record<string, unknown>).modelConfidence;

    const compiled = compileV9FactSetV2(retained);
    expect(compiled.assets[0]!.exitRoutes.find((candidate) => candidate.routeId === "amm-main")).toMatchObject({
      modelConfidence: "low",
    });
  });
  it("propagates serial SCC failure while keeping every active asset in the result", () => {
    const input = coreFixture();
    const beta = input.assets[1]! as unknown as V9AssetFactsV2;
    const gamma = input.assets[2]! as unknown as V9AssetFactsV2;
    const configureCycleMember = (
      asset: V9AssetFactsV2,
      upstreamAssetId: string,
      dependencyType: "wrapper" | "mechanism",
    ) => {
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
            edgeKey: canonicalV9DependencyEdgeKey(dependencyType, upstreamAssetId),
            upstreamAssetId,
            dependencyType,
            pathKind: "serial-dependency",
            weight: 1,
            economicRole: "serial-claim",
            evidenceRefIds: ["evidence:base"],
            failureDomains: [{ kind: "mint-control", key: `cycle:${upstreamAssetId}` }],
          },
        ],
        diagnostics: { graphState: "cycle", issueCodes: ["serial-scc"], sccMemberAssetIds: ["beta", "gamma"] },
      };
    };
    configureCycleMember(beta, "gamma", "wrapper");
    configureCycleMember(gamma, "beta", "mechanism");

    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets.map((asset) => asset.assetId)).toEqual(["alpha", "beta", "gamma"]);
    expect(evaluated.assets.find((asset) => asset.assetId === "beta")!.compactTrace.reasonCodes).toContain(
      "implementation-parent-cycle",
    );
    expect(evaluated.assets.find((asset) => asset.assetId === "gamma")!.compactTrace.reasonCodes).toContain(
      "implementation-parent-cycle",
    );
    expect(evaluated.assets.find((asset) => asset.assetId === "alpha")!.compactTrace.reasonCodes).toContain(
      "parent-cycle",
    );
    expect(evaluated.assets.every((asset) => asset.trace.finalScore === null)).toBe(true);
  });
  it("requires every active asset exactly once and keeps dependencies inside the active set", () => {
    const missing = coreFixture();
    missing.assets.pop();
    expect(() => compileV9FactSetV2(missing)).toThrow("Assets must match the exact active asset set");

    const duplicate = coreFixture();
    duplicate.activeAssetIds.push("alpha");
    expect(() => compileV9FactSetV2(duplicate)).toThrow("Duplicate canonical key: alpha");

    const external = coreFixture();
    external.assets[0]!.dependencies.edges[0]!.upstreamAssetId = "outside";
    external.assets[0]!.dependencies.edges[0]!.edgeKey = "collateral:outside";
    expect(() => compileV9FactSetV2(external)).toThrow("Dependency is outside active set");

    const compiled = compileV9FactSetV2(coreFixture());
    expect(() => assertExactV9ActiveAssetSet(compiled, ["gamma", "alpha", "beta"])).not.toThrow();
    expect(() => assertExactV9ActiveAssetSet(compiled, ["alpha", "beta"])).toThrow("exact active asset set");
  });
  it("parses retained V2 facts without injecting the additive chain distribution field", () => {
    const retainedCore = coreFixture();
    for (const asset of retainedCore.assets) {
      delete (asset.supply as { chainDistribution?: unknown }).chainDistribution;
    }
    const retained = compileV9FactSetV2(retainedCore);
    expect(
      retained.assets.every((asset) => !Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution")),
    ).toBe(true);
    expect(
      retained.assets.every((asset) => !Object.prototype.hasOwnProperty.call(asset, "operationalResilience")),
    ).toBe(true);

    const retainedBytes = stableJsonStringifyV1(retained);
    const reparsed = parseCompiledV9FactSetV2(JSON.parse(retainedBytes));
    expect(stableJsonStringifyV1(reparsed)).toBe(retainedBytes);
    expect(reparsed.v9FactSetDigest).toBe(retained.v9FactSetDigest);
  });
  it("rejects retained V2 fact sets closed", () => {
    const retained = compileV9FactSetV2(coreFixture());
    expect(() => readCompiledV9FactSetForEvaluation(retained)).toThrow(
      "Unsupported Safety Score v9 fact-set schema version: 2; expected 3",
    );
  });

  it.each([
    { observationState: "bounded-unknown", evidenceKind: "current" },
    { observationState: "stale", evidenceKind: "stale" },
  ] as const)("keeps $observationState empty coverage non-measured", ({
    observationState,
    evidenceKind,
  }) => {
    const core = nativeCompleteEmptyCoreFixture();
    const asset = core.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    const evidence =
      evidenceKind === "stale"
        ? createV9EvidenceReference(
            {
              evidenceId: "evidence:stale-exit-coverage",
              sourceId: "route-source",
              sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
              disposition: "observed",
              observedAtSec: 100,
              maxAgeSec: 100,
            },
            AS_OF_SEC,
          )
        : asset.evidence.find(
            (candidate) => candidate.evidenceId === "evidence:base",
          )!;
    const gap = createV9FactGapV3({
      gapId: `alpha:gap:exit-coverage:${observationState}`,
      reasonCode: "missing-same-notional-route",
      ownerDomain: "exit",
      policyRuleId: "exit.route.coverage",
      observationState,
      path: {
        kind: "local-component",
        componentKey: "exit-route-coverage",
      },
      message: "The empty exit surface is not a current complete observation.",
      evidenceRefIds: [evidence.evidenceId],
      responsibility: "producer-failed",
    });
    if (evidenceKind === "stale") asset.evidence.push(evidence);
    asset.gaps.push(gap);
    asset.exitStatus = createV9FactStatus({
      applicability: requiredV9Applicability("exit.route.coverage"),
      observationState,
      evidenceRefIds: [evidence.evidenceId],
      gapIds: [gap.gapId],
    });

    const evaluated = evaluateV9FactSet(
      compileV9FactSetV3(core),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((candidate) => candidate.assetId === "alpha")!;
    const reasons = evaluated.scoreInput.pillars.exit.reasons.filter(
      (reason) => reason.code === "missing-same-notional-route",
    );

    expect(evaluated.exit.reasons).toContain("missing-same-notional-route");
    expect(reasons).not.toHaveLength(0);
    expect(
      reasons.every(
        (reason) => reason.responsibility === "producer-failed",
      ),
    ).toBe(true);
  });
  it("preserves explicit exit-gap and mechanism-profile ownership over native complete-empty fallback", () => {
    const nativeWithGap = structuredClone(compileNativeV3FactSet(coreFixture()));
    const { v9FactSetDigest: _gapDigest, ...gapCore } = nativeWithGap;
    const gapAsset = gapCore.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    gapAsset.exitRoutes = gapAsset.exitRoutes.filter(
      (route) => !route.scoreEligible,
    );
    gapAsset.evidence = gapAsset.evidence.filter(
      (evidence) => evidence.evidenceId !== "evidence:route",
    );
    const exitGap = gapAsset.gaps.find(
      (gap) => gap.ownerDomain === "exit",
    )!;
    exitGap.reasonCode = "no-viable-exit-path";
    exitGap.responsibility = "issuer-undisclosed";

    const gapEvaluated = evaluateV9FactSet(
      compileV9FactSetV3(gapCore),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;
    expect(gapEvaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "no-viable-exit-path",
        responsibility: "issuer-undisclosed",
      }),
    );

    const profileCore = nativeCompleteEmptyCoreFixture();
    const profileAsset = profileCore.assets.find(
      (candidate) => candidate.assetId === "alpha",
    ) as V9AssetFactsV3;
    profileAsset.mechanismExitFacts = [{
      factKey: "protocol-redemption",
      disposition: "supported",
      quality: "adequate",
      evidenceRefIds: ["evidence:base"],
    }];
    const profileEvaluated = evaluateV9FactSet(
      compileV9FactSetV3(profileCore),
      V9_CANDIDATE_POLICY_V1,
    ).assets.find((asset) => asset.assetId === "alpha")!;

    expect(profileEvaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "missing-runtime-route-evidence",
        responsibility: "integration-missing",
      }),
    );
    expect(
      profileEvaluated.scoreInput.pillars.exit.reasons.some(
        (reason) =>
          reason.code === "no-viable-exit-path" &&
          reason.responsibility === "measured-adverse",
      ),
    ).toBe(false);
  });
  it("fails chain attribution closed when the distribution is unavailable or the supply fact is bounded", () => {
    const configureImmaterialChain = (input: ReturnType<typeof coreFixture>) => {
      for (const asset of input.assets.slice(1)) {
        asset.supply.chainDistribution = {
          chains: [
            { chainId: "chain:fixture", supplyUsd: 49_900, supplyShare: 0.0499 },
            { chainId: "other", supplyUsd: 950_100, supplyShare: 0.9501 },
          ],
          unattributedSupplyUsd: 0,
          unattributedSupplyShare: 0,
        };
      }
    };
    const chainSignal = (input: ReturnType<typeof coreFixture>, assetId: string) =>
      evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1)
        .assets.find((asset) => asset.assetId === assetId)!
        .scoreInput.dependencyStructuralSignals.find((signal) =>
          signal.failureDomainKeys.includes("chain:chain:fixture"),
        );

    const known = coreFixture();
    configureImmaterialChain(known);
    expect(chainSignal(known, "beta")?.severity).toBe("low");

    const unavailable = coreFixture();
    configureImmaterialChain(unavailable);
    (unavailable.assets[1]! as unknown as V9AssetFactsV2).supply.chainDistribution = null;
    expect(chainSignal(unavailable, "beta")?.severity).toBe("high");

    const bounded = coreFixture();
    configureImmaterialChain(bounded);
    const beta = bounded.assets[1]! as unknown as V9AssetFactsV2;
    const gap = createV9FactGap({
      gapId: "gap:bounded-chain-supply",
      reasonCode: "runtime-bridge-materiality-unavailable",
      ownerDomain: "control",
      policyRuleId: "v9.supply.current",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "chain-supply" },
      message: "The retained chain distribution is not current enough for score-bearing attribution.",
      evidenceRefIds: ["evidence:base"],
    });
    beta.gaps.push(gap);
    beta.supply.status = createV9FactStatus({
      applicability: requiredV9Applicability("v9.supply.current"),
      observationState: "bounded-unknown",
      evidenceRefIds: ["evidence:base"],
      gapIds: [gap.gapId],
    });
    expect(chainSignal(bounded, "beta")?.severity).toBe("high");
  });
  it("retains an unresolved archetype as an explicit fact state", () => {
    const input = coreFixture();
    const beta = input.assets[1]! as unknown as V9AssetFactsV2;
    const gap = createV9FactGap({
      gapId: "gap:missing-archetype",
      reasonCode: "missing-archetype",
      ownerDomain: "backing",
      policyRuleId: "backing.archetype.review",
      observationState: "missing",
      path: { kind: "local-component", componentKey: "mechanism-archetype" },
      message: "The mechanism archetype is unresolved.",
    });
    beta.archetype = "unresolved";
    beta.gaps = [gap];
    beta.mechanismRiskReview = {
      status: createV9FactStatus({
        applicability: requiredV9Applicability("backing.archetype.review"),
        observationState: "missing",
        gapIds: [gap.gapId],
      }),
      review: null,
    };
    const compiled = compileV9FactSetV2(input);
    expect(compiled.assets.find((asset) => asset.assetId === "beta")?.archetype).toBe("unresolved");
  });
  it("retains last-known stale and rejected route observations instead of erasing their facts", () => {
    const input = coreFixture();
    const alpha = input.assets[0] as ReturnType<typeof fullAsset>;
    const route = alpha.exitRoutes[0]!;
    const staleEvidence = createV9EvidenceReference(
      {
        evidenceId: "evidence:stale-route",
        sourceId: "route-source",
        sourceGenerationId: SOURCE_FINGERPRINTS.dex.generationId,
        disposition: "published",
        observedAtSec: 600,
        publishedAtSec: 610,
        maxAgeSec: 100,
      },
      AS_OF_SEC,
    );
    const staleGap = createV9FactGap({
      gapId: "gap:stale-route",
      reasonCode: "missing-runtime-route-evidence",
      ownerDomain: "exit",
      policyRuleId: "exit.route.freshness",
      observationState: "stale",
      path: optionalExitV9Path(route.routeKey),
      message: "The last-known route observation is outside its freshness window.",
      evidenceRefIds: [staleEvidence.evidenceId],
    });
    const staleStatus = createV9FactStatus({
      applicability: requiredV9Applicability("exit.route.freshness"),
      observationState: "stale",
      evidenceRefIds: [staleEvidence.evidenceId],
      gapIds: [staleGap.gapId],
    });
    alpha.evidence.push(staleEvidence);
    alpha.gaps.push(staleGap);
    route.status = staleStatus;
    route.settlementEvidenceRefIds = [staleEvidence.evidenceId];
    route.output.status = staleStatus;
    route.output.valuation = {
      ...route.output.valuation!,
      observedAtSec: staleEvidence.observedAtSec,
      freshness: staleEvidence.freshness,
      evidenceRefIds: [staleEvidence.evidenceId],
    };
    const rejectedRoute = alpha.exitRoutes[2]!;
    rejectedRoute.request = { requestedNotionalUsd: 100_000, maxCostBps: 200, settlementHorizonSec: 300 };
    rejectedRoute.capacityCurve = [
      {
        requestedNotionalUsd: 100_000,
        maxCostBps: 200,
        executableUsd: 25_000,
        completionRatio: 0.25,
        executionCostBps: 190,
      },
    ];

    const compiledAlpha = compileV9FactSetV2(input).assets[0]!;
    const compiledStaleRoute = compiledAlpha.exitRoutes.find((candidate) => candidate.routeId === "amm-main")!;
    expect(compiledStaleRoute).toMatchObject({
      status: { observationState: "stale" },
      output: { valuation: { valueRetentionRatio: 1, freshness: { state: "stale" } } },
    });
    expect(compiledStaleRoute.capacityCurve).toContainEqual(expect.objectContaining({ executableUsd: 80_000 }));
    expect(compiledAlpha.exitRoutes.find((candidate) => candidate.routeId === "unsupported")).toMatchObject({
      status: { observationState: "unsupported" },
      capacityCurve: [{ executableUsd: 25_000 }],
    });
  });

  it.each([
    [
      "compile clock",
      (input: ReturnType<typeof coreFixture>) => (input.compiledAtSec = AS_OF_SEC - 1),
      "compiledAtSec cannot predate",
    ],
    [
      "source clock",
      (input: ReturnType<typeof coreFixture>) => (input.sourceFingerprints.dex.observedAtSec = AS_OF_SEC + 1),
      "Source observation is later",
    ],
    [
      "evidence clock",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.evidence[0]!.observedAtSec = AS_OF_SEC + 1),
      "Evidence is later",
    ],
    [
      "evidence age",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.evidence[0]!.freshness.ageSec = 99),
      "Evidence age is not clock-derived",
    ],
    [
      "implementation clock",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.implementation.launchedAtSec = AS_OF_SEC + 1),
      "Implementation date is later",
    ],
    [
      "valuation clock",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.output.valuation!.asOfSec = AS_OF_SEC - 1),
      "Valuation clock does not match",
    ],
  ])("rejects an invalid %s", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });

  it.each([
    [
      "self dependency",
      (input: ReturnType<typeof coreFixture>) => {
        const edge = input.assets[0]!.dependencies.edges[0]!;
        edge.upstreamAssetId = "alpha";
        edge.edgeKey = "collateral:alpha";
      },
      "Self dependency is invalid",
    ],
    [
      "dependency key",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.dependencies.edges[0]!.edgeKey = "wrong"),
      "Expected collateral:beta",
    ],
    [
      "route key",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.routeKey = "wrong"),
      "Canonical route key must",
    ],
    [
      "route generation",
      (input: ReturnType<typeof coreFixture>) => {
        const route = input.assets[0]!.exitRoutes[0]!;
        route.sourceGenerationId = "dex:other";
        route.routeKey = canonicalV9RouteKey("dex", route.sourceGenerationId, route.routeId);
      },
      "Route generation does not match",
    ],
    [
      "evidence reference",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.implementation.status.evidenceRefIds = ["evidence:unknown"]),
      "Unknown evidence reference",
    ],
    [
      "gap path",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.gaps[0]!.path = optionalExitV9Path("dex:dex:g1:absent")),
      "Exit path does not reference",
    ],
    [
      "reserve generation",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.reserveExposures[0]!.sourceGenerationId = "wrong"),
      "Reserve provenance generation is inconsistent",
    ],
    [
      "control generation",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[0]!.sourceGenerationId = "wrong"),
      "Control provenance generation is inconsistent",
    ],
  ])("rejects an invalid %s identity", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });
  it("requires explicit evidence classes for curated reserve rows", () => {
    const input = coreFixture();
    const exposure = input.assets[0]!.reserveExposures[0]! as V9AssetFactsV2["reserveExposures"][number];
    exposure.provenance = "curated";
    exposure.sourceGenerationId = SOURCE_FINGERPRINTS.researchOverlays.generationId;
    delete exposure.evidenceClass;

    expect(() => compileV9FactSetV2(input)).toThrow("Curated reserve exposure requires an evidence class");
  });
  it("rejects static evidence classes on live reserve rows", () => {
    const input = coreFixture();
    const exposure = input.assets[0]!.reserveExposures[0]! as V9AssetFactsV2["reserveExposures"][number];
    exposure.evidenceClass = "independent";

    expect(() => compileV9FactSetV2(input)).toThrow("Live reserve exposure must not carry a static evidence class");
  });

  it.each([
    [
      "execution cost",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.capacityCurve[0]!.executionCostBps = 201),
      "Execution cost exceeds",
    ],
    [
      "value retention",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[0]!.output.valuation!.valueRetentionRatio = 0.9),
      "Value retention is inconsistent",
    ],
    [
      "holder access",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.holderAccess = "unknown"),
      "explicit access, execution",
    ],
    [
      "coverage class",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.coverageClass = "diagnostic"),
      "Diagnostic coverage cannot",
    ],
    [
      "settlement evidence",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.exitRoutes[0]!.settlementEvidenceRefIds = []),
      "lacks resource identity or settlement evidence",
    ],
    [
      "physical resource reuse",
      (input: ReturnType<typeof coreFixture>) =>
        (input.assets[0]!.exitRoutes[1]!.physicalResourceKeys = ["pool:fixture-main"]),
      "Physical resource pool:fixture-main is reused",
    ],
    [
      "bounded control without bound",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[1]!.capSemantics.bound = null),
      "Bounded control requires a bound",
    ],
    [
      "unknown control cap",
      (input: ReturnType<typeof coreFixture>) => (input.assets[0]!.controls[0]!.capSemantics.kind = "unknown"),
      "reviewed cap and economic-loss semantics",
    ],
    [
      "freeze-only loss scope",
      (input: ReturnType<typeof coreFixture>) => {
        input.assets[0]!.controls[2]!.claimImpairment = "unbounded";
        input.assets[0]!.controls[2]!.economicLossScope = "global-claim";
      },
      "Freeze-only posture cannot",
    ],
  ])("rejects incomplete score-bearing %s facts", (_label, mutate, message) => {
    const input = coreFixture();
    mutate(input);
    expect(() => compileV9FactSetV2(input)).toThrow(message);
  });
  it("rejects v8 report-card fields at the independent fact boundary", () => {
    const input = coreFixture();
    expect(() =>
      compileV9FactSetV2({
        ...input,
        overallScore: 90,
        dimensions: {},
        rawInputs: {},
      }),
    ).toThrow("Unrecognized key");
  });
});
