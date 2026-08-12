/**
 * Split out of the 6,063-line `safety-score-v9-fact-set.test.ts`. Assertions are
 * unchanged; the fixture builders now come from the shared V9 helper, imported
 * under their original local names so the bodies read exactly as before.
 */

import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import {
  V9_CANDIDATE_POLICY_V1,
} from "@shared/lib/safety-score-v9/policy";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  computeSafetyScoreV9ReserveExposureKey,
  materializeSafetyScoreV9FactSetExtension,
  type SafetyScoreV9FactSetExtensionV2,
} from "../safety-score-v9-fact-set";
import {
  buildSafetyScoreV9BaselineExtension,
} from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9RetainedRedemptionRoutes,
  buildSafetyScoreV9RouteReviews,
} from "../safety-score-v9-extension-routes";
import {
  V9_EVALUATION_TEST_TIMEOUT_MS,
  makeV9BoundedUnknownFeeRedemptionFixedInput as boundedUnknownFeeRedemptionFixedInput,
  makeV9FixedInput as exactFixedInput,
  makeV9Extension as extension,
  makeV9QueuedRedemptionFixedInput as queuedRedemptionFixedInput,
  v9Status as status,
} from "../../test-helpers/v9-fixed-input";

describe("Safety Score v9 exact base fact-set adapter — control and wrapper dimensions", { timeout: V9_EVALUATION_TEST_TIMEOUT_MS }, () => {
  it("maps only explicit oracle branch families and remains NR without a mechanism review", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            oracleRisk: {
              tier: "redundant-with-failover" as const,
              summary: "The fixture has reviewed oracle and liquidation branch behavior.",
              branchModel: "multi-branch" as const,
              branchApplicability: {
                disposition: "branches-required" as const,
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                rationale: "The collateral market requires explicit branch evidence.",
                sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
              },
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Oracle docs", url: "https://example.com/oracle" }],
              branches: [
                {
                  id: "eth",
                  label: "ETH branch",
                  tier: "redundant-with-failover" as const,
                  summary: "The ETH branch has complete reviewed controls.",
                  feeds: [{ provider: "Fixture", path: "ETH/USD", chain: "ethereum" }],
                  collateralParameters: [{ asset: "ETH", minimumCollateralRatioPct: 120 }],
                  liquidationMechanism: "Immediate permissionless liquidation through the branch.",
                  liquidationDelaySec: 0,
                  backstop: "A dedicated stability pool absorbs liquidated debt.",
                  shutdownOrBadDebtBehavior: "The branch shuts down and exposes residual bad debt explicitly.",
                  sources: [{ label: "Branch docs", url: "https://example.com/branches" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    const oracle = compiled.assets[0]!.economicControlReview.oracle;
    expect(oracle.status.observationState).toBe("known");
    expect(oracle.tier).toBe("redundant-with-failover");
    expect(oracle.branches.map((branch) => [branch.branch, branch.status.observationState])).toEqual([
      ["backstop", "known"],
      ["collateral-parameter", "known"],
      ["feed", "known"],
      ["liquidation", "known"],
      ["shutdown-bad-debt", "known"],
    ]);
    expect(oracle.branches.every((branch) => branch.mechanismKey !== null && branch.controlKey === null)).toBe(true);
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");

    const withoutOracle = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "cdp" as const }]]),
    });
    expect(withoutOracle.assets[0]!.economicControlReview).toBeNull();
  });

  it("compiles a reviewed top-level internal price without liquidation branches", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "synthetic-delta-neutral" as const,
            oracleRisk: {
              tier: "privileged-internal-pricing" as const,
              summary: "A privileged backend constructs the economically effective mint and redemption quote.",
              branchModel: "single-path" as const,
              branchApplicability: {
                disposition: "top-level-only" as const,
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                rationale: "The price authority applies without borrower liquidation branches.",
                sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }],
              },
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Pricing docs", url: "https://example.com/pricing" }],
            },
          },
        ],
      ]),
    });

    const oracle = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline).assets[0]!.economicControlReview.oracle;
    expect(oracle).toMatchObject({
      tier: "privileged-internal-pricing",
      liquidationBranchesApplicable: false,
      branches: [],
    });
    expect(oracle.status.observationState).toBe("known");
  });

  it("retains reviewed mint controls when the aggregate inventory remains unresolved", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "issuer-direct-mint" as const,
              authorityPosture: "concentrated-admin" as const,
              confidence: "unknown" as const,
              summary: "A reviewed issuer backend can mint the fixture token directly.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Issuer minter",
                  role: "direct-minter" as const,
                  authorityType: "issuer-backend" as const,
                  directMintAbility: "direct" as const,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The issuer minter path is reviewed, but reconciliation and upgrades are not established.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
                disposition: "unresolved" as const,
                // Open questions keep the review incomplete, so the control is
                // retained while reconciliation, incidents, and upgrades stay
                // unresolved (bounded-unknown).
                unresolvedQuestions: ["Reconciliation cadence and upgrade authority are not yet established."],
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    expect(baseline.assets[0]!.economicControlReview?.mint).toMatchObject({
      status: { observationState: "bounded-unknown" },
      reconciliation: "unknown",
      upgrade: { state: "unknown", controlKey: null },
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]).toMatchObject({
      status: { observationState: "bounded-unknown" },
      capSemantics: { kind: "unbounded", bound: null },
      claimImpairment: "unbounded",
      economicLossScope: "global-claim",
      keyCustody: "unknown",
      modulesOrGuards: "unknown",
      incidentState: "unknown",
    });
    expect(evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!.trace.finalGrade).not.toBe("NR");
  });

  it("reviews strategy-vault local holder-loss controls from a partial control inventory", () => {
    const fixed = exactFixedInput();
    const mixed = extension();
    const asset = mixed.assets[0]!;
    asset.variantKind = "strategy-vault";
    asset.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "The local custody control is reviewed, while bridge route authority remains unresolved.",
      controls: [
        {
          controlKey: "bridge:unresolved",
          deploymentKey: "ethereum:0x3333333333333333333333333333333333333333",
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          capSemantics: { kind: "unknown", bound: null },
          claimImpairment: "unknown",
          economicLossScope: "unknown",
          authority: null,
          delaySec: null,
          materialSupplyShare: 1,
          keyCustody: "unknown",
          modulesOrGuards: "unknown",
          incidentState: "unknown",
          failureDomains: [{ kind: "bridge-route", key: "ethereum:0x3333333333333333333333333333333333333333" }],
        },
        {
          controlKey: "custody:reviewed",
          deploymentKey: "asset:alpha",
          controlKind: "custody",
          scope: "global",
          capabilities: ["custody-transfer"],
          capSemantics: { kind: "bounded", bound: { amount: 0.25, unit: "supply-fraction" } },
          claimImpairment: "bounded",
          economicLossScope: "reserve-claim",
          authority: {
            authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
            model: "multisig",
            threshold: { required: 3, total: 6 },
          },
          delaySec: 86_400,
          materialSupplyShare: null,
          keyCustody: "unknown",
          modulesOrGuards: "unknown",
          incidentState: "none",
          failureDomains: [{ kind: "reserve-custodian", key: "issuer:alpha" }],
        },
      ],
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed).assets[0]!;
    expect(compiled.controlStatus).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiled.controls.find((control) => control.controlKey === "custody:reviewed")?.status).toMatchObject({
      observationState: "known",
    });
    expect(compiled.wrapperLocalFacts).toMatchObject({
      applicability: "wrapper",
      form: "strategy-vault",
      facts: {
        lossAbsorptionEmergencyControls: {
          disposition: "reviewed",
          assessment: "moderate",
          signals: expect.arrayContaining([
            "claim-affecting-control:custody:reviewed",
            "wrapper-local-controls-partial-review",
            "strategy-vault-holder-loss-controls-reviewed",
          ]),
        },
      },
    });
    if (compiled.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
    expect(compiled.wrapperLocalFacts.facts.lossAbsorptionEmergencyControls.evidenceRefIds.length).toBeGreaterThan(0);
  });

  // `safety-score-v9-fact-set-wrapper.ts` had no dedicated suite: the wrapper
  // dimensions were only ever reached through the happy path of other tests, so
  // the adverse and unavailable branches went unmeasured. These cases exercise
  // each remaining branch through the real compiler, not the private helpers.
  describe("wrapper-local dimension branches", () => {
    const strategyVaultExtension = () => {
      const reviewed = extension();
      reviewed.assets[0]!.variantKind = "strategy-vault";
      return reviewed;
    };
    const localControl = (
      overrides: Partial<
        NonNullable<Extract<SafetyScoreV9FactSetExtensionV2["assets"][number]["controlReview"], { state: "partially-reviewed-controls" }>>["controls"][number]
      > = {},
    ) => ({
      controlKey: "custody:reviewed",
      deploymentKey: "asset:alpha",
      controlKind: "custody" as const,
      scope: "global" as const,
      capabilities: ["custody-transfer" as const],
      capSemantics: { kind: "bounded" as const, bound: { amount: 0.25, unit: "supply-fraction" as const } },
      claimImpairment: "bounded" as const,
      economicLossScope: "reserve-claim" as const,
      authority: {
        authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
        model: "multisig" as const,
        threshold: { required: 3, total: 6 },
      },
      delaySec: 604_800,
      materialSupplyShare: null,
      keyCustody: "unknown" as const,
      modulesOrGuards: "unknown" as const,
      incidentState: "none" as const,
      failureDomains: [{ kind: "reserve-custodian" as const, key: "issuer:alpha" }],
      ...overrides,
    });
    const wrapperFacts = (
      reviewed: SafetyScoreV9FactSetExtensionV2,
      fixed: ReturnType<typeof exactFixedInput> = exactFixedInput(),
    ) => {
      const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, reviewed).assets[0]!;
      if (compiled.wrapperLocalFacts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
      if (compiled.wrapperLocalFacts.formDisposition !== "reviewed") {
        // A quarantined asset reports every dimension as
        // `asset-compilation-unavailable`, which would silently pass a
        // "disposition is not reviewed" assertion for the wrong reason.
        throw new Error(`Asset was quarantined: ${compiled.wrapperLocalFacts.formSignals.join(",")}`);
      }
      return compiled.wrapperLocalFacts.facts;
    };
    const boundedStatus = (policyRuleId: string, gapId: string) => ({
      applicability: { state: "required" as const, policyRuleId, rationale: null, gapId: null },
      observationState: "bounded-unknown" as const,
      evidenceRefIds: ["placeholder:evidence"],
      gapIds: [gapId],
    });
    /** Re-derives the content-addressed identities after mutating a capture. */
    const rebuild = (fixed: ReturnType<typeof exactFixedInput>) => {
      const {
        schemaVersion: omittedSchemaVersion,
        dexPayloadFingerprint: omittedDexPayloadFingerprint,
        redemptionPayloadFingerprint: omittedRedemptionPayloadFingerprint,
        registryFingerprint: omittedRegistryFingerprint,
        inputMethodologyVersions: omittedInputMethodologyVersions,
        baseInputGenerationId: omittedBaseInputGenerationId,
        ...draft
      } = fixed;
      void [
        omittedSchemaVersion,
        omittedDexPayloadFingerprint,
        omittedRedemptionPayloadFingerprint,
        omittedRegistryFingerprint,
        omittedInputMethodologyVersions,
        omittedBaseInputGenerationId,
      ];
      return createReportCardsFixedInput(draft);
    };

    it("escalates an active control incident to critical loss-absorption risk", () => {
      const reviewed = strategyVaultExtension();
      reviewed.assets[0]!.controlReview = {
        state: "partially-reviewed-controls",
        rationale: "One local custody control is reviewed and currently carries an active incident.",
        controls: [localControl({ incidentState: "active" })],
      };
      expect(wrapperFacts(reviewed).lossAbsorptionEmergencyControls).toMatchObject({
        disposition: "reviewed",
        assessment: "critical",
        signals: expect.arrayContaining(["active-control-incident:custody:reviewed"]),
      });
    });

    describe("contract mutability", () => {
      it("reports the upgrade review unavailable when the mint fact is not known", () => {
        const reviewed = strategyVaultExtension();
        const mint = reviewed.assets[0]!.economicControlReview!.mint;
        mint.status = boundedStatus("v9.control.mint-review", "extension-gap:mint:alpha");
        mint.reconciliation = "unknown";
        mint.upgrade = { state: "unknown", controlKey: null };
        expect(wrapperFacts(reviewed).contractMutability).toMatchObject({
          assessment: null,
          signals: ["wrapper-upgrade-review-unavailable"],
        });
      });

      it("attributes a reviewed upgrade control that never compiled to the integration, not the issuer", () => {
        const reviewed = strategyVaultExtension();
        const upgradeControlKey = "upgrade:unresolved";
        reviewed.assets[0]!.controlReview = {
          state: "partially-reviewed-controls",
          rationale: "The upgrade control is enumerated, but its authority and blast radius stay unresolved.",
          controls: [
            localControl({
              controlKey: upgradeControlKey,
              controlKind: "upgrade",
              capabilities: ["upgrade"],
              capSemantics: { kind: "unknown", bound: null },
              claimImpairment: "unknown",
              economicLossScope: "unknown",
              authority: null,
              delaySec: null,
              failureDomains: [],
            }),
          ],
        };
        reviewed.assets[0]!.economicControlReview!.mint.upgrade = {
          state: "reviewed",
          controlKey: upgradeControlKey,
        };
        expect(wrapperFacts(reviewed).contractMutability).toMatchObject({
          disposition: "integration-missing",
          signals: [`reviewed-upgrade-control-not-compiled:${upgradeControlKey}`],
        });
      });

      it("falls back to issuer nondisclosure when the upgrade authority is unreviewed", () => {
        const reviewed = strategyVaultExtension();
        reviewed.assets[0]!.economicControlReview!.mint.upgrade = { state: "unknown", controlKey: null };
        expect(wrapperFacts(reviewed).contractMutability).toMatchObject({
          disposition: "issuer-undisclosed",
          signals: ["wrapper-upgrade-authority-undisclosed"],
        });
      });
    });

    it("grades a leveraged reserve exposure high and names the factor", () => {
      const draft = structuredClone(exactFixedInput());
      // `leverage` is a first-class `ReserveRiskFactor`, so a curated slice can
      // state it directly; the wrapper dimension reads the compiled exposure.
      for (const slice of draft.liveReserveMap.alpha!) slice.riskFactors = ["leverage", "counterparty"];
      const leverage = wrapperFacts(strategyVaultExtension(), rebuild(draft)).leverage;
      expect(leverage).toMatchObject({
        disposition: "reviewed",
        assessment: "high",
        signals: expect.arrayContaining(["wrapper-leverage-factor:leverage"]),
      });
    });

    describe("exit dimensions", () => {
      const withRedemptionRoute = (
        fixed: ReturnType<typeof queuedRedemptionFixedInput>,
        overrides: Record<string, unknown> = {},
      ) => {
        const reviewed = strategyVaultExtension();
        reviewed.registryFingerprint = fixed.registryFingerprint;
        reviewed.assets[0]!.routeReviews = [
          ...buildSafetyScoreV9RouteReviews(fixed, "alpha").map((review) =>
            review.lane === "redemption" ? { ...review, ...overrides } : review,
          ),
        ];
        reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "alpha");
        return reviewed;
      };

      it("holds withdrawal terms unavailable when the redemption fee is reviewed-undisclosed", () => {
        const fixed = boundedUnknownFeeRedemptionFixedInput();
        const reviewed = strategyVaultExtension();
        reviewed.registryFingerprint = fixed.registryFingerprint;
        reviewed.assets[0]!.assetId = "usdc-circle";
        reviewed.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "usdc-circle");
        reviewed.assets[0]!.retainedRoutes = buildSafetyScoreV9RetainedRedemptionRoutes(fixed, "usdc-circle");
        expect(wrapperFacts(reviewed, fixed).withdrawalTerms).toMatchObject({
          disposition: "issuer-undisclosed",
          signals: ["wrapper-withdrawal-fee-undisclosed"],
        });
      });

      it("grades withdrawal terms by the worst reviewed access and execution posture", () => {
        const cases = [
          // Only the issuer can pull the redemption: holders have no route.
          [{ holderAccess: "issuer-only" }, "critical"],
          // Open to holders but gated by an allowlist.
          [{ holderAccess: "allowlisted" }, "moderate"],
          // Permissionless, atomic, bounded — nothing left to hold against it.
          [{}, "low"],
        ] as const;
        for (const [overrides, assessment] of cases) {
          const fixed = queuedRedemptionFixedInput(86_400, true);
          const reviewed = withRedemptionRoute(fixed, {
            settlementModel: "atomic",
            executionModel: "market-depth",
            executionCertainty: "bounded",
            holderAccess: "permissionless",
            settlementSlaSec: null,
            ...overrides,
          });
          expect(wrapperFacts(reviewed, fixed).withdrawalTerms, JSON.stringify(overrides)).toMatchObject({
            disposition: "reviewed",
            assessment,
          });
        }
      });

      it("grades a queued redemption by its settlement SLA", () => {
        for (const [settlementSlaSec, assessment] of [
          [8 * 86_400, "high"],
          [2 * 86_400, "moderate"],
        ] as const) {
          const fixed = queuedRedemptionFixedInput(86_400, true);
          const reviewed = withRedemptionRoute(fixed, {
            settlementModel: "queued",
            holderAccess: "permissionless",
            executionModel: "market-depth",
            executionCertainty: "bounded",
            settlementSlaSec,
          });
          expect(wrapperFacts(reviewed, fixed).withdrawalTerms, String(settlementSlaSec)).toMatchObject({
            assessment,
          });
        }
      });

      it("calls measured unwind critical when the exit fact is known but nothing is score-eligible", () => {
        // The only measured route prices its capacity above the policy stress
        // request's cost ceiling (200 bps), so the curve resolves to nothing at
        // the request. The exit portfolio is answered but has no capacity to
        // measure — an adverse answer, not a missing measurement, so it must
        // not be graded as unavailable.
        const draft = structuredClone(exactFixedInput());
        const observation = draft.dexLiqMap.alpha!.exitRouteObservations![0]!;
        observation.maxCostBps = 300;
        observation.capacityCurve = (observation.capacityCurve ?? []).map((point) => ({ ...point, maxCostBps: 300 }));
        const fixed = rebuild(draft);
        const reviewed = strategyVaultExtension();
        reviewed.assets[0]!.routeReviews = reviewed.assets[0]!.routeReviews.map((review) => ({
          ...review,
          executionCosts: review.executionCosts.map((cost) => ({ ...cost, maxCostBps: 300 })),
        }));
        const measuredUnwind = wrapperFacts(reviewed, fixed).measuredUnwind;
        expect(measuredUnwind).toMatchObject({
          disposition: "reviewed",
          assessment: "critical",
          signals: ["wrapper-measured-unwind:no-score-eligible-capacity"],
        });
      });

      it("reports measured unwind unavailable when the supply fact carries no stress request", () => {
        const reviewed = strategyVaultExtension();
        reviewed.assets[0]!.routeReviews = [];
        reviewed.assets[0]!.retainedRoutes = [];
        expect(wrapperFacts(reviewed).measuredUnwind).toMatchObject({
          assessment: null,
          signals: ["wrapper-measured-unwind-unavailable"],
        });
      });
    });
  });

  it("keeps a reviewed upgrade control known inside a partial control inventory", () => {
    const fixed = exactFixedInput();
    const mixed = extension();
    const asset = mixed.assets[0]!;
    const bridgeDeploymentKey = "ethereum:0x3333333333333333333333333333333333333333";
    const bridgeControlKey = "bridge:unresolved";
    const mintControlKey = "mint:unresolved";
    const upgradeControlKey = "upgrade:reviewed";

    asset.controlReview = {
      state: "partially-reviewed-controls",
      rationale: "The upgrade authority is reviewed, while bridge and direct-minter identities remain unresolved.",
      controls: [
        {
          controlKey: bridgeControlKey,
          deploymentKey: bridgeDeploymentKey,
          controlKind: "bridge",
          scope: "deployment",
          capabilities: ["bridge-mint"],
          capSemantics: { kind: "unbounded", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "deployment",
          authority: { authorityKey: `bridge-route:${bridgeDeploymentKey}`, model: "unknown", threshold: null },
          delaySec: null,
          materialSupplyShare: 1,
          keyCustody: "unknown",
          modulesOrGuards: "unknown",
          incidentState: "none",
          failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
        },
        {
          controlKey: mintControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "mint",
          scope: "global",
          capabilities: ["mint"],
          capSemantics: { kind: "raiseable", bound: null },
          claimImpairment: "bounded",
          economicLossScope: "global-claim",
          authority: null,
          delaySec: null,
          materialSupplyShare: null,
          keyCustody: "unknown",
          modulesOrGuards: "unknown",
          incidentState: "none",
          failureDomains: [],
        },
        {
          controlKey: upgradeControlKey,
          deploymentKey: "asset:alpha",
          controlKind: "upgrade",
          scope: "global",
          capabilities: ["upgrade"],
          capSemantics: { kind: "not-applicable", bound: null },
          claimImpairment: "unbounded",
          economicLossScope: "global-claim",
          authority: {
            authorityKey: "ethereum:0x4444444444444444444444444444444444444444",
            model: "multisig",
            threshold: { required: 3, total: 6 },
          },
          delaySec: null,
          materialSupplyShare: null,
          keyCustody: "unknown",
          modulesOrGuards: "unknown",
          incidentState: "none",
          failureDomains: [{ kind: "upgrade-control", key: "ethereum:0x4444444444444444444444444444444444444444" }],
        },
      ],
    };
    asset.economicControlReview = {
      ...asset.economicControlReview!,
      mint: {
        status: status("known", "v9.control.mint-review"),
        controlKey: mintControlKey,
        reconciliation: "not-applicable",
        supervision: "unknown",
        latestResolvedIncidentAtSec: null,
        upgrade: { state: "reviewed", controlKey: upgradeControlKey },
      },
      bridge: {
        status: {
          applicability: {
            state: "required",
            policyRuleId: "v9.control.bridge-review",
            rationale: null,
            gapId: null,
          },
          observationState: "bounded-unknown",
          evidenceRefIds: ["placeholder:evidence"],
          gapIds: ["extension-gap:bridge:alpha"],
        },
        routes: [],
      },
    };
    asset.supplyReview = {
      selectedBridgeRoutes: [
        {
          deploymentRouteKey: bridgeDeploymentKey,
          supplyUsd: 10_000_000,
          supplyShare: 1,
          reviewState: "selected-unresolved",
        },
      ],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 1,
      failureDomains: [{ kind: "bridge-route", key: bridgeDeploymentKey }],
    };

    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed).assets[0]!;
    expect(compiled.controlStatus).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiled.controls.find((control) => control.controlKey === upgradeControlKey)?.status).toMatchObject({
      observationState: "known",
      gapIds: [],
    });
    for (const unresolvedControlKey of [bridgeControlKey, mintControlKey]) {
      expect(compiled.controls.find((control) => control.controlKey === unresolvedControlKey)?.status).toMatchObject({
        observationState: "bounded-unknown",
        gapIds: [expect.stringContaining(unresolvedControlKey)],
      });
    }

    const evaluated = evaluateV9FactSet(compileSafetyScoreV9FactSetFromFixedInput(fixed, mixed), V9_CANDIDATE_POLICY_V1)
      .assets[0]!;
    expect(evaluated.control.reasons.map((reason) => reason.code)).not.toContain("missing-upgradeability-review");
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(bridgeControlKey))).toBe(true);
    expect(evaluated.control.reasons.some((reason) => reason.path.includes(mintControlKey))).toBe(true);
  });

  it("joins a capped minter to its separately reviewed cap-raising governor", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A protocol adapter mints within a cap that a separate governor can raise.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Capped protocol minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "The capped mint path and the separate cap-raising governor are both reviewed.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "reviewed-controls" });
    if (controlReview?.state !== "reviewed-controls") {
      throw new Error("expected reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({
      capSemantics: { kind: "raiseable", bound: null },
      claimImpairment: "bounded",
    });
    const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, baseline);
    expect(compiled.assets[0]!.controls[0]!.capSemantics).toEqual({ kind: "raiseable", bound: null });
  });

  it("does not join a capped minter to a cap raiser on another chain", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "user-collateralized-governed" as const,
              authorityPosture: "partially-bounded-admin" as const,
              confidence: "verified" as const,
              summary: "A capped minter and an unrelated cross-chain cap raiser.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Contract source", url: "https://example.com/source" }],
              },
              controls: [
                {
                  chain: "ethereum",
                  address: "0x1111111111111111111111111111111111111111",
                  label: "Ethereum capped minter",
                  role: "direct-minter" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "cap-limited" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                },
                {
                  chain: "arbitrum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Arbitrum cap governor",
                  role: "governor" as const,
                  authorityType: "dao-governor" as const,
                  directMintAbility: "parameter-only" as const,
                  canRaiseCap: true,
                  sources: [{ label: "Governance docs", url: "https://example.com/governance" }],
                },
              ],
              review: {
                sources: [{ label: "Minter docs", url: "https://example.com/minter" }],
                evidence: "Both controls are reviewed but operate on different chains.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    const controlReview = baseline.assets[0]!.controlReview;
    expect(controlReview).toMatchObject({ state: "partially-reviewed-controls" });
    if (controlReview?.state !== "partially-reviewed-controls") {
      throw new Error("expected partially reviewed controls");
    }
    expect(controlReview.controls[0]).toMatchObject({ capSemantics: { kind: "unknown", bound: null } });
  });

  it("does not infer immutable upgradeability from an immutable mint path", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Protocol contracts mediate issuance and no privileged issuer minter is resolved.",
              controls: [
                {
                  chain: "ethereum",
                  address: "0x2222222222222222222222222222222222222222",
                  label: "Protocol token",
                  role: "other" as const,
                  authorityType: "contract" as const,
                  directMintAbility: "none" as const,
                  sources: [{ label: "Token docs", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token docs", url: "https://example.com/token" }],
                evidence: "The token mint path is reviewed without a separate upgradeability conclusion.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.mint.upgrade).toEqual({
      state: "unknown",
      controlKey: null,
    });
  });

  it("resolves reviewed zero-share bridge semantics without contaminating the control aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "external-lock-mint" as const,
              summary: "A reviewed external bridge route represents the fixture token.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [
                {
                  id: "ethereum:0x1111111111111111111111111111111111111111",
                  destinationChain: "ethereum",
                  canonicalChain: "ethereum",
                  contractAddress: "0x1111111111111111111111111111111111111111",
                  protocol: "Fixture native issuance",
                  issuanceModel: "native-issuance" as const,
                  routeClass: "native" as const,
                  riskTier: "single-chain-or-native" as const,
                  semantics: "native-mint" as const,
                  scope: "canonical" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
                {
                  id: "base:0x3333333333333333333333333333333333333333",
                  sourceChain: "ethereum",
                  destinationChain: "base",
                  canonicalChain: "ethereum",
                  contractAddress: "0x3333333333333333333333333333333333333333",
                  protocol: "Fixture bridge",
                  issuanceModel: "bridge-representation" as const,
                  routeClass: "third-party" as const,
                  riskTier: "external-lock-mint" as const,
                  semantics: "lock-mint" as const,
                  scope: "peripheral" as const,
                  reviewDisposition: "reviewed" as const,
                  observedAt: "1970-01-01",
                  sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                },
              ],
            },
          },
        ],
      ]),
    });
    expect(baseline.assets[0]!.economicControlReview?.bridge).toMatchObject({
      status: { observationState: "known" },
      routes: [{ tier: "external-lock-mint" }],
    });
    // The reviewed bridge-representation route resolves cap, claim, and incident
    // semantics. Its unknown controller remains visible on the exact zero-share
    // control without making the aggregate partially reviewed.
    const bridgeControl =
      baseline.assets[0]!.controlReview?.state === "reviewed-controls"
        ? baseline.assets[0]!.controlReview.controls[0]
        : null;
    expect(bridgeControl).toMatchObject({
      materialSupplyShare: 0,
      authority: { model: "unknown" },
      capSemantics: { kind: "unbounded" },
      claimImpairment: "unbounded",
      keyCustody: "unknown",
      modulesOrGuards: "unknown",
      incidentState: "none",
    });
  });

  it("keeps a present empty bridge profile fail-closed on a single exact deployment", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            bridgeRouteRisk: {
              tier: "opaque-or-unknown" as const,
              summary: "The profile is present but has no reviewed deployment rows.",
              reviewedAt: "1970-01-01",
              reviewer: "Fixture reviewer",
              confidence: "verified" as const,
              sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
              routes: [],
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.supplyReview?.selectedBridgeRoutes).toEqual([
      {
        deploymentRouteKey: "unmatched-chain:alpha:ethereum",
        supplyUsd: 10_000_000,
        supplyShare: 1,
        reviewState: "unmatched",
      },
    ]);
    expect(baseline.assets[0]!.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "partially-reviewed-controls",
      controls: [expect.objectContaining({ deploymentKey: "unmatched-chain:alpha:ethereum", materialSupplyShare: 1 })],
    });
  });

  it("retains exact route shares while only material unresolved deployments contaminate the control aggregate", () => {
    const totalSupply = 1_000;
    const reviewedShare = 0.05;
    const baselineFor = (unresolvedShare: number | null) => {
      const row = (current: number) => ({
        current,
        circulatingPrevDay: current,
        circulatingPrevWeek: current,
        circulatingPrevMonth: current,
      });
      const fixed = exactFixedInput({
        chainSupplyByChain:
          unresolvedShare === null
            ? {}
            : {
                ethereum: row(totalSupply * (1 - reviewedShare - unresolvedShare)),
                base: row(totalSupply * reviewedShare),
                polygon: row(totalSupply * unresolvedShare),
              },
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "A reviewed canonical route coexists with an unresolved peripheral deployment.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [
                  {
                    id: "ethereum:0x1111111111111111111111111111111111111111",
                    destinationChain: "ethereum",
                    canonicalChain: "ethereum",
                    contractAddress: "0x1111111111111111111111111111111111111111",
                    protocol: "Fixture native issuance",
                    issuanceModel: "native-issuance" as const,
                    routeClass: "native" as const,
                    riskTier: "single-chain-or-native" as const,
                    semantics: "native-mint" as const,
                    scope: "canonical" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "base:0x2222222222222222222222222222222222222222",
                    sourceChain: "ethereum",
                    destinationChain: "base",
                    canonicalChain: "ethereum",
                    contractAddress: "0x2222222222222222222222222222222222222222",
                    protocol: "Fixture canonical bridge",
                    issuanceModel: "bridge-representation" as const,
                    routeClass: "canonical" as const,
                    riskTier: "canonical-rollup-bridge" as const,
                    semantics: "lock-mint" as const,
                    scope: "peripheral" as const,
                    reviewDisposition: "reviewed" as const,
                    observedAt: "1970-01-01",
                    sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                  },
                  {
                    id: "polygon:0x3333333333333333333333333333333333333333",
                    destinationChain: "polygon",
                    contractAddress: "0x3333333333333333333333333333333333333333",
                    protocol: "Unresolved fixture route",
                    issuanceModel: "unknown" as const,
                    routeClass: "unknown" as const,
                    riskTier: "opaque-or-unknown" as const,
                    semantics: "unknown" as const,
                    scope: "unknown" as const,
                    reviewDisposition: "unresolved" as const,
                    reviewNote: "The route controller and issuance semantics remain unresolved.",
                    observedAt: "1970-01-01",
                  },
                ],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
    const peripheralFixture = baselineFor(threshold - 0.001);
    const peripheral = peripheralFixture.asset;
    expect(peripheral.controlReview).toMatchObject({ state: "reviewed-controls" });
    expect(peripheral.economicControlReview?.bridge.status.observationState).toBe("known");
    if (peripheral.controlReview?.state !== "reviewed-controls") {
      throw new Error("expected below-threshold deployment controls to be reviewed");
    }
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("base:")),
    ).toMatchObject({ materialSupplyShare: reviewedShare });
    expect(
      peripheral.controlReview.controls.find((control) => control.deploymentKey.startsWith("polygon:")),
    ).toMatchObject({
      materialSupplyShare: threshold - 0.001,
      capSemantics: { kind: "unknown" },
      claimImpairment: "unknown",
      keyCustody: "unknown",
      modulesOrGuards: "unknown",
      incidentState: "unknown",
    });
    const compiledPeripheral = compileSafetyScoreV9FactSetFromFixedInput(
      peripheralFixture.fixed,
      peripheralFixture.extension,
    ).assets[0]!;
    expect(compiledPeripheral.controlStatus).toMatchObject({ observationState: "known" });
    expect(compiledPeripheral.controls.find((control) => control.deploymentKey.startsWith("base:"))).toMatchObject({
      authority: { model: "unknown" },
      status: { observationState: "bounded-unknown" },
    });
    const compiledPeripheralUnresolved = compiledPeripheral.controls.find((control) =>
      control.deploymentKey.startsWith("polygon:"),
    )!;
    expect(compiledPeripheralUnresolved.status).toMatchObject({ observationState: "bounded-unknown" });
    expect(compiledPeripheralUnresolved.status.gapIds).toHaveLength(1);
    expect(
      evaluateV9FactSet(
        compileSafetyScoreV9FactSetFromFixedInput(peripheralFixture.fixed, peripheralFixture.extension),
        V9_CANDIDATE_POLICY_V1,
      ).assets[0]!.control.reasons.some((reason) => reason.path.includes(compiledPeripheralUnresolved.controlKey)),
    ).toBe(false);

    for (const unresolvedShare of [threshold, threshold + 0.01, null]) {
      const materialFixture = baselineFor(unresolvedShare);
      const material = materialFixture.asset;
      expect(material.controlReview).toMatchObject({ state: "partially-reviewed-controls" });
      expect(material.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
      const compiledMaterial = compileSafetyScoreV9FactSetFromFixedInput(
        materialFixture.fixed,
        materialFixture.extension,
      );
      const evaluatedMaterial = evaluateV9FactSet(compiledMaterial, V9_CANDIDATE_POLICY_V1).assets[0]!;
      expect(evaluatedMaterial.control.reasons.some((reason) => reason.code === "unresolved-control-identity")).toBe(
        true,
      );
    }
  });

  it("exempts only complete independently subthreshold unmatched bridge inventories", () => {
    const row = (current: number) => ({
      current,
      circulatingPrevDay: current,
      circulatingPrevWeek: current,
      circulatingPrevMonth: current,
    });
    const route = (id: string, disposition: "reviewed" | "unresolved" = "unresolved") => ({
      id,
      destinationChain: id.slice(0, id.indexOf(":")),
      contractAddress: id.slice(id.indexOf(":") + 1),
      protocol: disposition === "reviewed" ? "Fixture native issuance" : "Unresolved fixture route",
      issuanceModel: disposition === "reviewed" ? ("native-issuance" as const) : ("unknown" as const),
      routeClass: disposition === "reviewed" ? ("native" as const) : ("unknown" as const),
      riskTier: disposition === "reviewed" ? ("single-chain-or-native" as const) : ("opaque-or-unknown" as const),
      semantics: disposition === "reviewed" ? ("native-mint" as const) : ("unknown" as const),
      scope: disposition === "reviewed" ? ("canonical" as const) : ("unknown" as const),
      reviewDisposition: disposition,
      reviewNote: disposition === "unresolved" ? "The route semantics remain unresolved." : undefined,
      observedAt: "1970-01-01",
      sources: disposition === "reviewed" ? [{ label: "Bridge docs", url: "https://example.com/bridge" }] : undefined,
    });
    const baselineFor = (chainShares: Record<string, number>, extraRoutes: ReturnType<typeof route>[] = []) => {
      const fixed = exactFixedInput({
        chainSupplyByChain: Object.fromEntries(
          Object.entries(chainShares).map(([chain, share]) => [chain, row(share * 10_000)]),
        ),
      });
      const extension = buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              bridgeRouteRisk: {
                tier: "canonical-rollup-bridge" as const,
                summary: "Fixture bridge inventory for exact deployment materiality.",
                reviewedAt: "1970-01-01",
                reviewer: "Fixture reviewer",
                confidence: "verified" as const,
                sources: [{ label: "Bridge docs", url: "https://example.com/bridge" }],
                routes: [route("ethereum:0x1111111111111111111111111111111111111111", "reviewed"), ...(extraRoutes as ReturnType<typeof route>[])],
              },
            },
          ],
        ]),
      });
      return { fixed, extension, asset: extension.assets[0]! };
    };

    const independent = baselineFor({
      ethereum: 0.5005,
      base: 0.0999,
      polygon: 0.0999,
      arbitrum: 0.0999,
      optimism: 0.0999,
      avalanche: 0.0999,
    });
    expect(independent.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    const independentBridgeControls =
      independent.asset.controlReview?.state === "reviewed-controls" ||
      independent.asset.controlReview?.state === "partially-reviewed-controls"
        ? independent.asset.controlReview.controls.filter((control) => control.controlKind === "bridge")
        : [];
    expect(independentBridgeControls).toHaveLength(0);
    const independentCompiled = compileSafetyScoreV9FactSetFromFixedInput(
      independent.fixed,
      independent.extension,
    );
    const independentEvaluation = evaluateV9FactSet(independentCompiled, V9_CANDIDATE_POLICY_V1).assets[0]!;
    expect(
      independentEvaluation.control.reasons.some((reason) => reason.code === "material-bridge-supply-unmatched"),
    ).toBe(false);
    expect(
      independentCompiled.assets[0]!.gaps.some(
        (gap) =>
          gap.reasonCode === "unresolved-control-identity" &&
          gap.path.kind === "deployment-control",
      ),
    ).toBe(false);

    const reviewedLockMint = (id: string) => ({
      ...route(id, "reviewed"),
      issuanceModel: "bridge-representation" as const,
      routeClass: "canonical" as const,
      riskTier: "canonical-rollup-bridge" as const,
      semantics: "lock-mint" as const,
      scope: "peripheral" as const,
      protocol: "Fixture canonical bridge",
    });
    const usdtShape = baselineFor(
      { ethereum: 0.85, base: 0.1, Starknet: 0.05 },
      [reviewedLockMint("base:0x2222222222222222222222222222222222222222") as unknown as ReturnType<typeof route>],
    );
    expect(usdtShape.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    const usdtShapeControls =
      usdtShape.asset.controlReview?.state === "reviewed-controls" ||
      usdtShape.asset.controlReview?.state === "partially-reviewed-controls"
        ? usdtShape.asset.controlReview.controls.filter((control) => control.controlKind === "bridge")
        : [];
    expect(usdtShapeControls).toHaveLength(1);
    expect(usdtShapeControls[0]?.deploymentKey).toBe("base:0x2222222222222222222222222222222222222222");
    const usdtShapeCompiled = compileSafetyScoreV9FactSetFromFixedInput(usdtShape.fixed, usdtShape.extension);
    expect(
      usdtShapeCompiled.assets[0]!.gaps.some(
        (gap) =>
          gap.reasonCode === "unresolved-control-identity" &&
          gap.path.kind === "deployment-control" &&
          gap.path.deploymentKey.toLowerCase().includes("starknet"),
      ),
    ).toBe(false);

    const exactThreshold = baselineFor({ ethereum: 0.9, base: 0.1 });
    expect(exactThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const pooledBelow = baselineFor({ ethereum: 0.9001, "Future Chain": 0.0499, future_chain: 0.05 });
    expect(pooledBelow.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(pooledBelow.asset.economicControlReview?.bridge.status.applicability.state).toBe("required");
    expect(
      pooledBelow.asset.supplyReview?.selectedBridgeRoutes.find((candidate) => candidate.reviewState === "unmatched"),
    ).toMatchObject({ deploymentRouteKey: "unmatched-chain-label-pool:alpha", supplyShare: 0.0999 });
    expect(
      pooledBelow.asset.controlReview?.state === "reviewed-controls" ||
        pooledBelow.asset.controlReview?.state === "partially-reviewed-controls"
        ? pooledBelow.asset.controlReview.controls.some(
            (control) => control.deploymentKey === "unmatched-chain-label-pool:alpha",
          )
        : false,
    ).toBe(false);
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(pooledBelow.fixed, pooledBelow.extension).assets[0]!.gaps.some(
        (gap) =>
          gap.path.kind === "deployment-control" &&
          gap.path.deploymentKey === "unmatched-chain-label-pool:alpha",
      ),
    ).toBe(false);

    const pooledAtThreshold = baselineFor({ ethereum: 0.9, "Future Chain": 0.05, future_chain: 0.05 });
    expect(pooledAtThreshold.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
    expect(
      pooledAtThreshold.asset.controlReview?.state === "reviewed-controls" ||
        pooledAtThreshold.asset.controlReview?.state === "partially-reviewed-controls"
        ? pooledAtThreshold.asset.controlReview.controls.some(
            (control) => control.deploymentKey === "unmatched-chain-label-pool:alpha",
          )
        : false,
    ).toBe(true);
    expect(
      compileSafetyScoreV9FactSetFromFixedInput(pooledAtThreshold.fixed, pooledAtThreshold.extension).assets[0]!.gaps.some(
        (gap) =>
          gap.path.kind === "deployment-control" &&
          gap.path.deploymentKey === "unmatched-chain-label-pool:alpha",
      ),
    ).toBe(true);

    const ambiguous = baselineFor({ ethereum: 0.95, base: 0.05 }, [
      route("base:0x2222222222222222222222222222222222222222"),
      route("base:0x3333333333333333333333333333333333333333"),
    ]);
    expect(ambiguous.asset.supplyReview?.selectedBridgeRoutes).toContainEqual(
      expect.objectContaining({ deploymentRouteKey: "ambiguous-chain:alpha:base", supplyShare: 0.05 }),
    );
    expect(ambiguous.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");

    const canonicalOrphan = baselineFor({ ethereum: 1 }, [
      route("hyperevm:0x4444444444444444444444444444444444444444"),
    ]);
    expect(canonicalOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("known");
    expect(canonicalOrphan.asset.economicControlReview?.bridge.status.applicability.state).toBe("not-applicable");
    expect(
      canonicalOrphan.asset.controlReview?.state === "reviewed-controls"
        ? canonicalOrphan.asset.controlReview.controls.find((control) => control.deploymentKey.startsWith("hyperevm:"))
        : null,
    ).toMatchObject({ materialSupplyShare: 0, capSemantics: { kind: "unknown" } });

    const uncanonicalizableOrphan = baselineFor({ ethereum: 1 }, [
      route("futurechain:0x5555555555555555555555555555555555555555"),
    ]);
    expect(uncanonicalizableOrphan.asset.economicControlReview?.bridge.status.observationState).toBe("bounded-unknown");
  });

  it("does not let an unresolved access-only control contaminate a resolved aggregate", () => {
    const fixed = exactFixedInput();
    const baseline = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "cdp" as const,
            mintAuthority: {
              mintPath: "immutable-user-collateralized" as const,
              authorityPosture: "none-resolved" as const,
              confidence: "verified" as const,
              summary: "Immutable user issuance includes a non-claiming control with no privileged authority identity.",
              upgradeability: {
                model: "immutable" as const,
                canChangeMintLogic: false,
                sources: [{ label: "Token source", url: "https://example.com/token" }],
              },
              controls: [
                {
                  label: "Non-claiming protocol surface",
                  role: "other" as const,
                  authorityType: "none" as const,
                  directMintAbility: "none" as const,
                  canRaiseCap: false,
                  sources: [{ label: "Token source", url: "https://example.com/token" }],
                },
              ],
              review: {
                sources: [{ label: "Token source", url: "https://example.com/token" }],
                evidence: "The reviewed surface cannot mint or impair the protocol claim.",
                reviewer: "Fixture reviewer",
                reviewedAt: "1970-01-01",
              },
            },
          },
        ],
      ]),
    });

    expect(baseline.assets[0]!.controlReview).toMatchObject({
      state: "reviewed-controls",
      controls: [
        expect.objectContaining({
          economicLossScope: "access-only",
          authority: null,
        }),
      ],
    });
  });

  it("rejects registry drift and future reviews, then quarantines stale evidence claimed as known", () => {
    const fixed = exactFixedInput();
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        registryFingerprint: "f".repeat(64),
        metaById: new Map([["alpha", { id: "alpha", mechanismArchetype: "fiat-cash" as const }]]),
      }),
    ).toThrow(/registry fingerprint/);
    expect(() =>
      buildSafetyScoreV9BaselineExtension(fixed, {
        metaById: new Map([
          [
            "alpha",
            {
              id: "alpha",
              mechanismArchetype: "fiat-cash" as const,
              blacklistabilityReview: {
                reviewedStatus: true,
                sourceFreeRationale: "Fixture-only review.",
                evidence: "This future-dated review must not enter an earlier candidate.",
                reviewer: "Fixture reviewer",
                reviewedAt: "2026-07-14",
              },
            },
          ],
        ]),
      }),
    ).toThrow(/later than the scoring clock/);

    const staleKnown = extension();
    staleKnown.assets[0]!.researchEvidence = [
      {
        evidenceKey: "stale-control-review",
        sourceId: "fixture.stale-control-review",
        observedAtSec: 8_000,
        publishedAtSec: null,
        url: "https://example.com/stale",
        contentSha256: "a".repeat(64),
        confidence: "verified",
        maxAgeSec: 500,
      },
    ];
    staleKnown.assets[0]!.componentEvidence = [{ componentKey: "control", evidenceKeys: ["stale-control-review"] }];
    const staleKnownMaterialized = materializeSafetyScoreV9FactSetExtension(fixed, staleKnown);
    expect(
      compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(
        fixed,
        staleKnownMaterialized,
      ).quarantines,
    ).toEqual([{ assetId: "alpha", code: "fact-build-failed" }]);
  });

  it("exports stable reserve exposure identities for exact overlay joins", () => {
    const slice = exactFixedInput().liveReserveMap.alpha![0]!;
    expect(computeSafetyScoreV9ReserveExposureKey(slice)).toMatch(/^reserve:[a-f0-9]{24}$/);
    expect(computeSafetyScoreV9ReserveExposureKey({ ...slice, pct: 50 })).toBe(
      computeSafetyScoreV9ReserveExposureKey(slice),
    );
  });
});
