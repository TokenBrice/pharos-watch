/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it } from "vitest";
import fraxMetaSource from "@shared/data/stablecoins/coins/frax-frax.json";
import fraxReserveSource from "@shared/data/stablecoins/domains/reserves/frax-frax.json";
import flipcashMetaSource from "@shared/data/stablecoins/coins/usdf-flipcash.json";
import astherusMetaSource from "@shared/data/stablecoins/coins/usdf-astherus.json";
import megaMetaSource from "@shared/data/stablecoins/coins/usdm-mega.json";
import wrappedMSource from "@shared/data/stablecoins/coins/wm-m0.json";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  computeSafetyScoreV9ReserveExposureKey,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9/fact-set";
import {
  buildReviewedReserveClassifications,
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import {
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
  V9_FIXTURE_OBSERVED_AT_SEC as OBSERVED_AT_SEC,
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9FixedInput as exactFixedInput,
  makeV9ThreeAssetFixedInput as exactThreeAssetFixedInput,
  makeV9TwoAssetFixedInput as exactTwoAssetFixedInput,
  makeV9Extension as extension,
  v9ExtensionRoleEdge as extensionRoleEdge,
  makeV9RoleExtension as roleExtension,
  v9Status as status,
} from "../../test-helpers/v9-fixed-input";

describe("Safety Score v9 exact base fact-set adapter — dependencies, roles and quarantine", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("carries reviewed mechanism redemption into the exit evidence responsibility path", () => {
    const fixed = exactFixedInput();
    const profiled = extension();
    profiled.assets[0]!.mechanismExitFacts = [{
      factKey: "protocol-redemption",
      disposition: "supported",
      quality: "adequate",
    }];
    profiled.assets[0]!.routeReviews = [];
    profiled.assets[0]!.retainedRoutes = [];

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled);
    const asset = compiled.assets[0]!;
    expect(asset.mechanismExitFacts).toEqual([
      expect.objectContaining({
        factKey: "protocol-redemption",
        disposition: "supported",
        quality: "adequate",
      }),
    ]);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(evaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "missing-runtime-route-evidence",
        path: "exit:mechanism-profile:protocol-redemption",
        responsibility: "integration-missing",
      }),
    );
    expect(evaluated.scoreInput.pillars.exit.reasons).not.toContainEqual(
      expect.objectContaining({ code: "no-viable-exit-path" }),
    );
  });

  it("defaults retained v2 route reviews without modeled confidence to low", () => {
    const fixed = exactFixedInput();
    const retained = structuredClone(extension());
    delete (retained.assets[0]!.routeReviews[0] as unknown as Record<string, unknown>).modelConfidence;

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, retained);
    expect(compiled.assets[0]!.exitRoutes[0]).toMatchObject({ modelConfidence: "low" });
  });

  it("propagates post-role exit scores through three hops and never improves after adding an unmitigated role", () => {
    const evaluateChain = (gammaCompletionRatio: number) => {
      const fixed = exactThreeAssetFixedInput(gammaCompletionRatio);
      const profiled = roleExtension(fixed, {
        alpha: [extensionRoleEdge("beta", "exit-dependency")],
        beta: [extensionRoleEdge("gamma", "exit-dependency")],
      });
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled);
      const alphaEdge = compiled.assets.find((asset) => asset.assetId === "alpha")!.dependencies.edges[0]!;
      expect(alphaEdge).toMatchObject({
        edgeKey: "exit-dependency:mechanism:beta",
        economicRole: "exit-dependency",
        pathKind: "local-component",
      });
      expect(alphaEdge.evidenceRefIds).not.toHaveLength(0);
      return evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    };

    const stronger = evaluateChain(0.8);
    const weaker = evaluateChain(0.05);
    const exitScore = (set: ReturnType<typeof evaluateChain>, assetId: string) =>
      set.assets.find((asset) => asset.assetId === assetId)!.scoreInput.pillars.exit.score!;

    expect(exitScore(weaker, "gamma")).toBeLessThan(exitScore(stronger, "gamma"));
    expect(exitScore(weaker, "beta")).toBeLessThan(exitScore(stronger, "beta"));
    expect(exitScore(weaker, "alpha")).toBeLessThan(exitScore(stronger, "alpha"));

    const fixed = exactThreeAssetFixedInput(0.05);
    const withoutAddedRole = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(fixed, { alpha: [extensionRoleEdge("beta", "exit-dependency")] }),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    const withAddedRole = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(fixed, {
          alpha: [
            extensionRoleEdge("beta", "exit-dependency"),
            extensionRoleEdge("gamma", "exit-dependency"),
          ],
        }),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(exitScore(withAddedRole, "alpha")).toBeLessThanOrEqual(exitScore(withoutAddedRole, "alpha"));
  });

  it("propagates the effective oracle role subdimension through three hops", () => {
    const evaluateOracleChain = (tier: "redundant-with-failover" | "single-source-or-laggy") => {
      const fixed = exactThreeAssetFixedInput();
      const profiled = roleExtension(fixed, {
        alpha: [extensionRoleEdge("beta", "oracle-nav")],
        beta: [extensionRoleEdge("gamma", "oracle-nav")],
      });
      const gamma = profiled.assets.find((asset) => asset.assetId === "gamma")!;
      gamma.economicControlReview = {
        ...gamma.economicControlReview!,
        oracle: {
          status: status("known", "v9.control.oracle-review"),
          tier,
          branches: [],
        },
      };
      return evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(fixed, profiled),
        V9_CANDIDATE_POLICY_V1,
      );
    };
    const stronger = evaluateOracleChain("redundant-with-failover");
    const weaker = evaluateOracleChain("single-source-or-laggy");
    const controlScore = (set: ReturnType<typeof evaluateOracleChain>, assetId: string) =>
      set.assets.find((asset) => asset.assetId === assetId)!.scoreInput.pillars.control.score!;

    expect(controlScore(weaker, "gamma")).toBeLessThan(controlScore(stronger, "gamma"));
    expect(controlScore(weaker, "beta")).toBeLessThan(controlScore(stronger, "beta"));
    expect(controlScore(weaker, "alpha")).toBeLessThan(controlScore(stronger, "alpha"));
  });

  it("contains a sub-material exit/control SCC to its role pillars without a serial-cycle NR reason", () => {
    const fixed = exactThreeAssetFixedInput();
    const evaluated = evaluateV9FactSet(
      compileSafetyScoreV9FactSetFromFixedInput(
        fixed,
        roleExtension(
          fixed,
          {
            alpha: [extensionRoleEdge("beta", "exit-dependency", 0.01)],
            beta: [extensionRoleEdge("alpha", "control-operator", 0.01)],
          },
        ),
      ),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(evaluated.dependencyPlan.cyclicComponents).toContainEqual(["alpha", "beta"]);
    expect(evaluated.dependencyPlan.serialCycleAssetIds).toEqual([]);
    for (const assetId of ["alpha", "beta"]) {
      const asset = evaluated.assets.find((candidate) => candidate.assetId === assetId)!;
      expect(
        asset.trace.finalGrade,
        JSON.stringify({
          nrReasons: asset.trace.nrReasons,
          dependencyReasons: asset.scoreInput.dependencyReasons,
          pillars: asset.scoreInput.pillars,
        }),
      ).not.toBe("NR");
      expect(asset.scoreInput.dependencyReasons.map((reason) => reason.code)).not.toContain(
        "implementation-parent-cycle",
      );
      expect(asset.scoreInput.dependencyReasons.map((reason) => reason.code)).not.toContain("parent-cycle");
      expect(asset.dependencyInputs.roleInputs).toEqual([
        expect.objectContaining({ cycleBlocked: true, boundedUnknown: true, score: null }),
      ]);
    }
    const alpha = evaluated.assets.find((asset) => asset.assetId === "alpha")!;
    const beta = evaluated.assets.find((asset) => asset.assetId === "beta")!;
    expect(alpha.scoreInput.pillars.exit.reasons.map((reason) => reason.code)).toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(alpha.scoreInput.pillars.control.reasons.map((reason) => reason.code)).not.toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(beta.scoreInput.pillars.control.reasons.map((reason) => reason.code)).toContain(
      "nonmaterial-dependency-unavailable",
    );
    expect(beta.scoreInput.pillars.exit.reasons.map((reason) => reason.code)).not.toContain(
      "nonmaterial-dependency-unavailable",
    );
  });

  it("rejects wrapper relationships that use a non-serial economic role", () => {
    const fixed = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 1, type: "wrapper" }],
          dependencyReview: {
            reviewedAt: "1970-01-01",
            reviewer: "Fixture reviewer",
            confidence: "verified",
            sources: [{ label: "Role review", url: "https://example.com/dependencies/alpha" }],
            rationale: "The wrapper relationship is deliberately assigned an incompatible role.",
            relationships: [
              {
                id: "beta",
                weight: 1,
                type: "wrapper",
                economicRole: "control-operator",
                reason: "Invalid wrapper role for this fixture.",
              },
            ],
          },
        },
      ],
      ["beta", { id: "beta", mechanismArchetype: "fiat-cash", launchDate: "1970-01-01" }],
    ]);

    const alpha = buildSafetyScoreV9BaselineExtension(fixed, { metaById }).assets.find(
      (asset) => asset.assetId === "alpha",
    )!;

    expect(alpha.dependencies).toMatchObject({
      diagnostics: { graphState: "invalid", issueCodes: ["invalid-role-type:beta"] },
      edges: [],
    });
  });

  it("marks mutual serial claims as a dependency cycle", () => {
    const fixed = exactTwoAssetFixedInput({ omitAlphaReserve: true });
    const dependencyReview = (upstreamAssetId: string) => ({
      reviewedAt: "1970-01-01",
      reviewer: "Fixture reviewer",
      confidence: "verified" as const,
      sources: [{ label: "Cycle review", url: "https://example.com/dependencies/cycle" }],
      rationale: "The fixture deliberately creates a mutual serial claim.",
      relationships: [
        {
          id: upstreamAssetId,
          weight: 1,
          type: "wrapper" as const,
          economicRole: "serial-claim" as const,
          reason: "Mutual serial claim for cycle handling.",
        },
      ],
    });
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          dependencies: [{ id: "beta", weight: 1, type: "wrapper" }],
          dependencyReview: dependencyReview("beta"),
        },
      ],
      [
        "beta",
        {
          id: "beta",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
          dependencies: [{ id: "alpha", weight: 1, type: "wrapper" }],
          dependencyReview: dependencyReview("alpha"),
        },
      ],
    ]);

    const baseline = buildSafetyScoreV9BaselineExtension(fixed, { metaById });

    expect(baseline.assets.find((asset) => asset.assetId === "alpha")!.dependencies).toMatchObject({
      diagnostics: { graphState: "cycle", issueCodes: ["dependency-cycle"], sccMemberAssetIds: ["alpha", "beta"] },
      edges: [expect.objectContaining({ economicRole: "serial-claim", upstreamAssetId: "beta" })],
    });
    expect(baseline.assets.find((asset) => asset.assetId === "beta")!.dependencies).toMatchObject({
      diagnostics: { graphState: "cycle", issueCodes: ["dependency-cycle"], sccMemberAssetIds: ["alpha", "beta"] },
      edges: [expect.objectContaining({ economicRole: "serial-claim", upstreamAssetId: "alpha" })],
    });
  });

  it("loads every economic role from reviewed production metadata and preserves the Frax WTGXX non-link", () => {
    const productionMeta = [
      {
        ...fraxMetaSource,
        reserves: fraxReserveSource.reserves,
        reserveReview: fraxReserveSource.reserveReview,
      },
      flipcashMetaSource,
      astherusMetaSource,
      megaMetaSource,
      wrappedMSource,
    ] as unknown as V9ExtensionRegistryMeta[];
    const metaById = new Map(productionMeta.map((meta) => [meta.id, meta] as const));
    const expectedRoles = [
      ["wm-m0", "m-m0", "serial-claim"],
      ["usdf-flipcash", "usdc-circle", "basket-exposure"],
      ["usdf-astherus", "usdt-tether", "exit-dependency"],
      ["usdm-mega", "usdtb-ethena", "control-operator"],
      ["usdf-astherus", "usdt-tether", "oracle-nav"],
    ] as const;
    for (const [assetId, upstreamAssetId, role] of expectedRoles) {
      expect(metaById.get(assetId)?.dependencyReview?.relationships).toContainEqual(
        expect.objectContaining({ id: upstreamAssetId, economicRole: role }),
      );
    }

    const frax = metaById.get("frax-frax")!;
    const wtgxx = frax.reserves!.find((reserve) => reserve.name.startsWith("WTGXX"))!;
    expect(frax.reserveReview?.nonLinkDispositions).toContainEqual(
      expect.objectContaining({
        reserveIndex: frax.reserves!.indexOf(wtgxx),
        disposition: "untracked-exogenous-asset",
        candidateCoinIds: ["wtgxx-wisdomtree"],
      }),
    );
    // The reviewed non-link only overlays the live slice once the reserve
    // review's own date gate has opened, so the clock sits at or after
    // `reserveReview.reviewedAt`/`compositionAsOf` (2026-08-12).
    const classifications = buildReviewedReserveClassifications(
      [{ ...wtgxx, coinId: "wtgxx-wisdomtree", depType: "collateral" }],
      frax,
      Date.parse("2026-08-13T00:00:00.000Z") / 1_000,
    );
    expect(classifications).toEqual([
      expect.objectContaining({
        trackedAssetDisposition: "reviewed-non-link",
        // The reviewed non-link must strip the candidate edge, never publish it.
        trackedAssetId: null,
      }),
    ]);
  });

  it("builds a conservative baseline overlay without inventing missing reviews", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash",
            launchDate: "2020-01-01",
          },
        ],
      ]),
    });
    expect(baseline.assets[0]).toMatchObject({
      assetId: "alpha",
      archetype: "fiat-cash",
      // The reviewed cash reserve backs the claim/custody components at the
      // bounded quality; assurance stays missing without a proof-of-reserves
      // report, and the captured DEX observation yields a derived exit route.
      mechanismRiskReview: {
        archetype: "fiat-cash",
        claimAndSegregation: { status: { observationState: "bounded-unknown" } },
        custodyContinuity: { status: { observationState: "bounded-unknown" } },
        assuranceAndReconciliation: { status: { observationState: "missing" } },
      },
      controlReview: null,
      economicControlReview: null,
      accessReview: null,
      routeReviews: [{ lane: "dex", routeId: "dex:primary", coverageClass: "exact-complete" }],
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.gaps.map((gap) => gap.reasonCode)).toEqual(
      expect.arrayContaining(["missing-access-review"]),
    );
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  describe("inherited freeze exposure named by a reserve slice", () => {
    // FreezeWatch resolves "inherited" from any positive freezable reserve
    // share with no parent required, so a reserve-side inherited verdict has
    // no `variantOf`/`mintAuthority.inheritedFrom` to name. Before this branch
    // accepted the reserve edge, those assets scored `missing-access-review`
    // ("we never looked") and curators were pushed to write
    // a direct false verdict instead — the wave-1 over-suppression of 29
    // honest verdicts, restored in `1134ab32f`.
    const inheritedReview = {
      reviewedStatus: "inherited" as const,
      evidence: "Reserve holds a directly freezable upstream stablecoin.",
      reviewer: "test",
      reviewedAt: "1970-01-01",
      sources: [{ label: "Issuer transparency page", url: "https://example.test/reserves" }],
    };
    const upstreamMeta = (id: string, freezeCapable: boolean) => ({
      id,
      mechanismArchetype: "fiat-cash" as const,
      launchDate: "2020-01-01",
      blacklistabilityReview: {
        reviewedStatus: freezeCapable,
        evidence: "Contract exposes an owner-only blacklist.",
        reviewer: "test",
        reviewedAt: "1970-01-01",
        sources: [{ label: "Contract", url: "https://example.test/contract" }],
      },
    });
    const holderMeta = (reserves: { name: string; pct: number; coinId?: string }[]) => ({
      id: "alpha",
      mechanismArchetype: "fiat-cash" as const,
      launchDate: "2020-01-01",
      blacklistabilityReview: inheritedReview,
      reserves: reserves.map((reserve) => ({ ...reserve, risk: "low" as const })),
    });
    // `upstreamAssetId` is validated against the compiled fact set's active
    // asset set, so every candidate upstream has to be a scored asset. The
    // three-asset harness supplies alpha + beta + gamma.
    const threeAssetInput = () => exactThreeAssetFixedInput();
    const buildExtension = (entries: [string, unknown][]) =>
      buildSafetyScoreV9BaselineExtension(threeAssetInput(), {
        metaById: new Map([
          ...entries,
          ...(["alpha", "beta", "gamma"] as const)
            .filter((id) => !entries.some(([entryId]) => entryId === id))
            .map((id) => [id, { id, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01" }] as [string, unknown]),
        ]) as never,
      });
    const buildAccess = (entries: [string, unknown][]) => buildExtension(entries).assets[0]!.accessReview;

    it("names the largest directly freeze-capable reserve upstream and grants the disposition", () => {
      const entries: [string, unknown][] = [
        [
          "alpha",
          holderMeta([
            { name: "USDC", pct: 10, coinId: "beta" },
            { name: "USDT", pct: 40, coinId: "gamma" },
          ]),
        ],
        ["beta", upstreamMeta("beta", true)],
        ["gamma", upstreamMeta("gamma", true)],
      ];
      const access = buildAccess(entries);
      expect(access?.freeze.structuralDisposition).toBe("inherited-upstream");
      expect(access?.freeze.reviews).toHaveLength(1);
      expect(access?.freeze.reviews[0]).toMatchObject({
        source: "upstream",
        reach: "possible",
        upstreamAssetId: "gamma",
        // A reserve upstream freezes the holding, not the mint surface, so it
        // must not share a failure domain with a declared parent.
        failureDomains: [{ kind: "reserve-issuer", key: "asset:gamma" }],
      });
      // Scoring-visible state is unchanged: the disposition only reclassifies
      // the gap from missing data to a measured structural fact.
      expect(access?.freeze.status.observationState).toBe("bounded-unknown");

      const compiled = compileSafetyScoreV9FactSetFromFixedInput(threeAssetInput(), buildExtension(entries));
      const freezeGaps = compiled.assets
        .find((asset) => asset.assetId === "alpha")!
        .gaps.filter((gap) => gap.gapId.includes(":gap:access:freeze"));
      expect(freezeGaps.length).toBeGreaterThan(0);
      expect(
        freezeGaps.every(
          (gap) => gap.reasonCode === "inherited-access-exposure" && gap.responsibility === "measured-adverse",
        ),
      ).toBe(true);
    });

    it("ties break on the lexicographically first id so the fact set replays byte-for-byte", () => {
      const access = buildAccess([
        [
          "alpha",
          holderMeta([
            { name: "USDT", pct: 25, coinId: "gamma" },
            { name: "USDC", pct: 25, coinId: "beta" },
          ]),
        ],
        ["beta", upstreamMeta("beta", true)],
        ["gamma", upstreamMeta("gamma", true)],
      ]);
      expect(access?.freeze.reviews[0]).toMatchObject({ upstreamAssetId: "beta" });
    });

    it("a declared parent still wins over a reserve slice", () => {
      const access = buildAccess([
        ["alpha", { ...holderMeta([{ name: "USDT", pct: 90, coinId: "gamma" }]), variantOf: "beta" }],
        ["beta", upstreamMeta("beta", true)],
        ["gamma", upstreamMeta("gamma", true)],
      ]);
      expect(access?.freeze.reviews[0]).toMatchObject({
        upstreamAssetId: "beta",
        failureDomains: [{ kind: "mint-control", key: "asset:beta" }],
      });
    });

    it("refuses to name an unnamed, unscored, or not-directly-freezable upstream but still measures it", () => {
      const cases: [string, [string, unknown][]][] = [
        // No `coinId`: the slice names no asset, so there is nothing to attribute.
        ["unnamed", [["alpha", holderMeta([{ name: "USDC", pct: 90 }])]]],
        // `coinId` outside the active (scored) set — naming it would make the
        // whole fact set unparseable.
        ["unscored", [["alpha", holderMeta([{ name: "USDC", pct: 90, coinId: "delta" }])]]],
        // Upstream that cannot itself freeze holder balances directly: naming it
        // would assert a chain this branch does not verify.
        [
          "not-freeze-capable",
          [
            ["alpha", holderMeta([{ name: "USDC", pct: 90, coinId: "beta" }])],
            ["beta", upstreamMeta("beta", false)],
          ],
        ],
      ];
      for (const [label, entries] of cases) {
        const access = buildAccess(entries);
        // Owner ruling 2026-08-10: no upstream identity may be asserted, but
        // the evidenced inherited verdict is a measured structural fact rather
        // than missing data, so the review is retained instead of dropped —
        // dropping it published these assets as never reviewed.
        expect(access?.freeze.structuralDisposition, label).toBe("inherited-untracked-upstream");
        expect(access?.freeze.reviews, label).toMatchObject([
          {
            source: "blacklist",
            reach: "possible",
            upstreamAssetId: null,
            failureDomains: [],
          },
        ]);
        expect(access?.freeze.status.observationState, label).toBe("bounded-unknown");
      }
    });

    it("classifies the untracked-upstream gap as measured exposure, not a missing review", () => {
      const entries: [string, unknown][] = [["alpha", holderMeta([{ name: "USDC", pct: 90 }])]];
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(threeAssetInput(), buildExtension(entries));
      const freezeGaps = compiled.assets
        .find((asset) => asset.assetId === "alpha")!
        .gaps.filter((gap) => gap.gapId.includes(":gap:access:freeze"));
      expect(freezeGaps.length).toBeGreaterThan(0);
      expect(
        freezeGaps.every(
          (gap) => gap.reasonCode === "inherited-access-exposure" && gap.responsibility === "measured-adverse",
        ),
      ).toBe(true);
      expect(freezeGaps.some((gap) => gap.message.includes("not a tracked asset"))).toBe(true);
    });
  });

  it("compiles exact base facts and explicit reviews without consulting v8 score outputs", () => {
    const fixed = exactFixedInput();
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension());
    const alpha = compiled.assets[0]!;

    expect(compiled.baseInputGenerationId).toBe(fixed.baseInputGenerationId);
    expect(compiled.asOfSec).toBe(AS_OF_SEC);
    expect(compiled.sourceFingerprints.dex).toMatchObject({
      generationId: fixed.dexGenerationId,
      payloadSha256: fixed.dexPayloadFingerprint,
      observedAtSec: OBSERVED_AT_SEC,
    });
    expect(compiled.activeAssetIds).toEqual(["alpha"]);
    expect(
      compiled.assets.every((asset) => Object.prototype.hasOwnProperty.call(asset.supply, "chainDistribution")),
    ).toBe(true);
    expect(alpha.mechanismRiskReview.review?.archetype).toBe("fiat-cash");
    expect(alpha.economicControlReview.mint.status.applicability.state).toBe("not-applicable");
    expect(alpha.accessReview.transfer.posture).toBe("permissionless");
    expect(alpha.reserveStatus.observationState).toBe("known");
    expect(alpha.supply).toMatchObject({
      sourceKind: "usd-denominated-circulating",
      referencePriceUsd: null,
      circulatingUsd: 10_000_000,
      chainDistribution: {
        chains: [{ chainId: "ethereum", supplyUsd: 10_000_000, supplyShare: 1 }],
        unattributedSupplyUsd: 0,
        unattributedSupplyShare: 0,
      },
    });
    expect(alpha.exitRoutes[0]).toMatchObject({
      routeId: "dex:primary",
      modelConfidence: "medium",
      status: { observationState: "known" },
      scoreEligible: true,
    });
    expect(alpha.gaps).toEqual([]);

    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);
    expect(evaluated.assets).toHaveLength(1);
    expect(evaluated.assets[0]!.trace).toMatchObject({ finalGrade: "B+", finalScore: 77 });
    expect(evaluated.assets[0]!.access).toMatchObject({
      transfer: "permissionless",
      freezeExposure: "none-known",
      primaryExit: "permissionless",
    });
    expect(evaluated.assets[0]!.stressState.scoreInput).toEqual(evaluated.assets[0]!.scoreInput);

    const low = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 1 }), extension());
    const high = compileSafetyScoreV9FactSetFromFixedInput(exactFixedInput({ liquidityScore: 99 }), extension());
    expect(low.assets).toEqual(high.assets);
    expect(low.baseInputGenerationId).not.toBe(high.baseInputGenerationId);
  });

  it("quarantines one asset-local fact build failure as current NR", () => {
    const fixed = exactFixedInput();
    const reviewed = extension();
    const reserve = fixed.liveReserveMap.alpha![0]!;
    reviewed.assets[0]!.reserveClassifications = [
      {
        exposureKey: computeSafetyScoreV9ReserveExposureKey(reserve),
        classificationKey: "fixture:conflicting-reserve",
        assetClass: "cryptoasset",
        issuerOrObligorKey: "issuer:alpha",
        riskFactors: ["counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
        failureDomains: [
          { kind: "reserve-issuer", key: "issuer:alpha" },
        ],
      },
    ];
    const materialized = materializeSafetyScoreV9FactSetExtension(
      fixed,
      reviewed,
    );

    const result =
      compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        fixed,
        materialized,
      );
    const asset = result.factSet.assets[0]!;
    const evaluated = evaluateV9FactSet(
      result.factSet,
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.quarantines).toEqual([
      { assetId: "alpha", code: "fact-build-failed" },
    ]);
    expect(asset.gaps).toContainEqual(
      expect.objectContaining({
        gapId: "alpha:gap:asset-compilation",
        responsibility: "producer-failed",
      }),
    );
    expect(evaluated.assets[0]!.trace).toMatchObject({
      finalGrade: "NR",
      finalScore: null,
    });
  });

  it("keeps unaffected assets unchanged when one asset is quarantined", () => {
    const fixed = exactTwoAssetFixedInput();
    const metaById = new Map<string, V9ExtensionRegistryMeta>([
      [
        "alpha",
        {
          id: "alpha",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
        },
      ],
      [
        "beta",
        {
          id: "beta",
          mechanismArchetype: "fiat-cash",
          launchDate: "1970-01-01",
        },
      ],
    ]);
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById,
    });
    const clean = compileSafetyScoreV9FactSetFromFixedInput(
      fixed,
      baseline,
    );
    const isolated = structuredClone(baseline);
    const alpha = isolated.assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    expect(alpha.reserveClassifications[0]).toBeDefined();
    alpha.reserveClassifications[0]!.assetClass = "cryptoasset";
    const materialized = materializeSafetyScoreV9FactSetExtension(
      fixed,
      isolated,
    );

    const result =
      compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        fixed,
        materialized,
      );
    const evaluated = evaluateV9FactSet(
      result.factSet,
      V9_CANDIDATE_POLICY_V1,
    );

    expect(result.factSet.activeAssetIds).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.quarantines).toEqual([
      { assetId: "alpha", code: "fact-build-failed" },
    ]);
    const isolatedBeta = result.factSet.assets.find(
      (asset) => asset.assetId === "beta",
    )!;
    const cleanBeta = clean.assets.find(
      (asset) => asset.assetId === "beta",
    )!;
    expect({ ...isolatedBeta, evidence: [] }).toEqual({
      ...cleanBeta,
      evidence: [],
    });
    expect(
      evaluated.assets.find((asset) => asset.assetId === "alpha")
        ?.trace,
    ).toMatchObject({ finalGrade: "NR", finalScore: null });
  });

  it("preserves parent dependencies when an upstream asset is quarantined", () => {
    const fixed = exactThreeAssetFixedInput();
    const reviewed = roleExtension(fixed, {
      beta: [
        {
          upstreamAssetId: "alpha",
          dependencyType: "mechanism",
          weight: 1,
          failureDomains: [],
        },
      ],
    });
    const alpha = reviewed.assets.find(
      (asset) => asset.assetId === "alpha",
    )!;
    alpha.reserveClassifications = [
      {
        exposureKey: computeSafetyScoreV9ReserveExposureKey(
          fixed.liveReserveMap.alpha![0]!,
        ),
        classificationKey: "fixture:conflicting-parent-reserve",
        assetClass: "cryptoasset",
        issuerOrObligorKey: "issuer:alpha",
        riskFactors: ["counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
        failureDomains: [
          { kind: "reserve-issuer", key: "issuer:alpha" },
        ],
      },
    ];
    const materialized = materializeSafetyScoreV9FactSetExtension(
      fixed,
      reviewed,
    );

    const result =
      compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        fixed,
        materialized,
      );
    const evaluated = evaluateV9FactSet(
      result.factSet,
      V9_CANDIDATE_POLICY_V1,
    );
    const beta = evaluated.assets.find(
      (asset) => asset.assetId === "beta",
    )!;

    expect(beta.trace).toMatchObject({
      finalGrade: "NR",
      finalScore: null,
    });
    expect(beta.scoreInput.parent).toMatchObject({
      required: true,
      score: null,
    });
    expect(
      result.factSet.assets
        .find((asset) => asset.assetId === "beta")!
        .dependencies.edges,
    ).toContainEqual(
      expect.objectContaining({
        upstreamAssetId: "alpha",
      }),
    );
    const candidate = buildSafetyScoreV9Candidate({
      fixedInput: fixed,
      extension: reviewed,
      publishedAtSec: fixed.clockSec,
    });
    expect(candidate.quarantineAffectedAssetIds).toEqual([
      "alpha",
      "beta",
    ]);
    expect(candidate.candidate.cards).toHaveLength(
      fixed.activeAssetIds.length,
    );
    expect(
      candidate.candidate.cards.find((card) => card.id === "alpha"),
    ).toMatchObject({ grade: "NR", score: null });
  });

});
