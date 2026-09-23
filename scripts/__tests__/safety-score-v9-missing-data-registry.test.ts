import policyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  compileNativeV3FactSet,
  coreFixture,
  createV9FactGap,
  createV9FactStatus,
  requiredV9Applicability,
  minimalAsset,
} from "@shared/lib/__tests__/safety-score-v9-facts.fixture-support";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
} from "@shared/test-utils/report-cards-v9";
import { makeCoin } from "./stablecoin-catalog.test-support";
import { describe, expect, it } from "vitest";
import {
  classifyV9MissingDataWorkType,
  generateV9MissingDataRegistry,
  classifyV9ScoreProjectionWorkType,
  likelyTouchpoints,
  mechanismOverlayCaptureDayWarnings,
  mechanismResolutionMode,
  scoreProjectionResolutionMode,
  type V9MissingDataWorkType,
} from "../maintenance/generate-safety-score-v9-missing-data-registry";

function classify(reasonCode: string, componentKey = "fixture"): V9MissingDataWorkType {
  return classifyV9MissingDataWorkType({
    reasonCode,
    path: { kind: "local-component", componentKey },
  } as Parameters<typeof classifyV9MissingDataWorkType>[0]);
}

function generateExitProjectionFixture(
  reasonCodes: readonly ("unproven-settlement-bound" | "unsupported-same-notional-route")[],
) {
  const assetId = "exit-fixture";
  const core = coreFixture();
  const asset = minimalAsset(assetId);
  const gapId = `${assetId}:gap:exit-portfolio-coverage`;
  asset.gaps = [
    createV9FactGap({
      gapId,
      reasonCode: "incomplete-dex-route-coverage",
      ownerDomain: "exit",
      policyRuleId: "v9.exit.same-notional-route",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
      message: "Reviewed DEX pools do not all carry score-eligible exact route observations.",
      evidenceRefIds: ["evidence:base"],
    }),
  ];
  asset.exitStatus = createV9FactStatus({
    applicability: requiredV9Applicability("v9.exit.same-notional-route"),
    observationState: "bounded-unknown",
    evidenceRefIds: ["evidence:base"],
    gapIds: [gapId],
  });
  const compiledFacts = compileNativeV3FactSet({
    ...core,
    activeAssetIds: [assetId],
    assets: [asset],
  });
  const policy = loadV9MethodologyPolicy(policyAsset);
  const pillars = makeReportCardsV9Pillars({ backing: 80, exit: 80, control: 80 });
  pillars.exit.reasons = reasonCodes.map((code) => ({
    code,
    path: "exit:fixture-route",
    message: `${code} fixture`,
  }));
  const card = makeReportCardsV9Card({
    id: assetId,
    pillars,
    reasonCodes: [...reasonCodes].sort(),
  });

  return generateV9MissingDataRegistry({
    replay: {
      pipeline: {
        compiledFacts,
        candidate: {
          model: "v9-critical-path",
          schemaVersion: 5,
          lifecycle: "active",
          candidateId: "safety-score-v9:fixture",
          policyVersion: policy.policy.releaseVersion,
          publicationGenerationId: "report-cards:v9:fixture",
          baseInputGenerationId: compiledFacts.baseInputGenerationId,
          factSetDigest: compiledFacts.v9FactSetDigest,
          resultDigest: "b".repeat(64),
          policy: {
            id: policy.policy.policyId,
            semanticDigest: policy.semanticDigest,
          },
          evaluationBuildDigest: "c".repeat(64),
          sourceGenerations: { fixture: "fixture:g1" },
          asOfSec: compiledFacts.asOfSec,
          publishedAtSec: compiledFacts.asOfSec,
          completeness: {
            expectedCount: 1,
            ratedCount: 1,
            notRatedCount: 0,
            notRatedIds: [],
          },
          cards: [card],
        },
      },
    },
    policy: policyAsset,
    catalogEntries: [{
      id: assetId,
      file: `shared/data/stablecoins/coins/${assetId}.json`,
      coin: makeCoin(assetId),
    }],
  });
}

describe("Safety Score v9 mechanism-overlay capture-day warnings", () => {
  it("warns for reviews dated on the capture UTC day", () => {
    const captureClockSec = Date.UTC(2026, 8, 21, 7, 55) / 1_000;
    const warning =
      "mechanism review dated 2026-09-21 is inadmissible until the next UTC day at this capture clock; assets: susn-noon";

    expect(mechanismOverlayCaptureDayWarnings(captureClockSec)).toEqual([warning]);
    expect(mechanismOverlayCaptureDayWarnings(Date.UTC(2099, 0, 1) / 1_000)).toEqual([]);
  });
});

describe("Safety Score v9 missing-data work routing", () => {
  it.each([
    ["missing-pillar-evidence", "chain-supply", "CHAIN_SUPPLY"],
    ["missing-pillar-evidence", "asset-compilation", "ASSET_COMPILATION"],
    ["missing-access-review", "access:freeze", "ACCESS_REVIEW"],
    ["missing-archetype", "mechanism-risk-review", "ARCHETYPE_CLASSIFICATION"],
    ["bounded-mechanism-review", "mechanism-review:backstop", "MECHANISM_REVIEW"],
    ["missing-reserve-composition", "reserve-composition", "RESERVE_COMPOSITION"],
    ["material-reserve-slice-unstructured", "fixture", "RESERVE_SLICE"],
    ["missing-runtime-route-evidence", "exit-routes", "EXIT_RUNTIME_ROUTE"],
    ["incomplete-dex-route-coverage", "exit-portfolio-coverage", "EXIT_DEX_COVERAGE"],
    ["unresolved-exit-output", "fixture", "EXIT_OUTPUT"],
    ["missing-mint-authority", "economic-control:mint", "MINT_AUTHORITY"],
    ["unresolved-control-identity", "deployment-controls", "DEPLOYMENT_CONTROLS"],
    ["missing-upgradeability-review", "deployment-controls", "DEPLOYMENT_CONTROLS"],
    ["missing-oracle-profile", "economic-control:oracle", "ORACLE_PROFILE"],
    ["incomplete-oracle-liquidation-branch", "economic-control:oracle:feed", "ORACLE_BRANCH"],
    ["missing-bridge-routes", "economic-control:bridge", "BRIDGE_ROUTE_REVIEW"],
    ["runtime-bridge-materiality-unavailable", "bridge-materiality", "BRIDGE_MATERIALITY"],
    ["missing-peg-input", "peg", "PEG_INPUT"],
    ["unreviewed-dependency-relationships", "effective-dependencies", "DEPENDENCY_REVIEW"],
    ["missing-implementation-date", "implementation-date", "IMPLEMENTATION_DATE"],
  ] as const)("routes %s at %s to %s", (reasonCode, componentKey, expected) => {
    expect(classify(reasonCode, componentKey)).toBe(expected);
  });

  it("fails closed when a new reason has no agent work definition", () => {
    expect(() => classify("unregistered-reason")).toThrow(/Missing agent work-type definition/);
  });

  it.each([
    ["unknown-upgrade-authority", "DEPLOYMENT_CONTROLS"],
    ["selected-bridge-route-unresolved", "BRIDGE_ROUTE_REVIEW"],
    ["missing-same-notional-route", "EXIT_RUNTIME_ROUTE"],
    ["unsupported-same-notional-route", "EXIT_DEX_COVERAGE"],
    ["unresolved-mint-authority", "MINT_AUTHORITY"],
    ["material-unknown-reserve-exposure", "RESERVE_COMPOSITION"],
    ["missing-custody-profile", "RESERVE_COMPOSITION"],
    ["missing-latest-assurance-report", "RESERVE_COMPOSITION"],
  ] as const)("routes score-only reason %s to %s", (reasonCode, expected) => {
    expect(classifyV9ScoreProjectionWorkType(reasonCode)).toBe(expected);
  });

  it.each([
    ["unproven-settlement-bound", "EXIT_SETTLEMENT_BOUND", true],
    ["unsupported-same-notional-route", "EXIT_DEX_COVERAGE", false],
  ] as const)(
    "consolidates score projection reason %s only with compiled work type %s",
    (reasonCode, workType, requiresSupplementalTask) => {
      const registry = generateExitProjectionFixture([reasonCode]);
      const stablecoin = registry.stablecoins[0]!;
      const projection = stablecoin.scoreProjectionGaps.find((gap) => gap.reasonCode === reasonCode);

      expect(projection).toMatchObject({ workType, requiresSupplementalTask });
      expect(
        stablecoin.missingItems.filter((item) => item.taskSource === "score-projection-gap"),
      ).toEqual(
        requiresSupplementalTask
          ? [expect.objectContaining({
              workType,
              claimGroupId: `${workType}:exit-fixture`,
            })]
          : [],
      );
    },
  );

  it("associates projection coverage with the exact work type when one stream mixes EXIT work types", () => {
    const registry = generateExitProjectionFixture([
      "unsupported-same-notional-route",
      "unproven-settlement-bound",
    ]);
    const stablecoin = registry.stablecoins[0]!;
    const compiledTaskIds = stablecoin.missingItems
      .filter((item) => item.taskSource === "compiled-fact-gap")
      .map((item) => item.taskId);
    const supplementalTaskIds = stablecoin.missingItems
      .filter((item) => item.taskSource === "score-projection-gap")
      .map((item) => item.taskId);
    const dexProjection = stablecoin.scoreProjectionGaps.find(
      (gap) => gap.reasonCode === "unsupported-same-notional-route",
    );
    const settlementProjection = stablecoin.scoreProjectionGaps.find(
      (gap) => gap.reasonCode === "unproven-settlement-bound",
    );

    // EXIT_DEX_COVERAGE and EXIT_SETTLEMENT_BOUND share the EXIT stream, but the
    // compiled DEX task covers only the DEX projection; the settlement
    // projection is covered by its own supplemental task, never by the DEX task.
    expect(compiledTaskIds).toHaveLength(1);
    expect(supplementalTaskIds).toHaveLength(1);
    expect(dexProjection).toMatchObject({
      workType: "EXIT_DEX_COVERAGE",
      coveredByTaskIds: compiledTaskIds,
      requiresSupplementalTask: false,
    });
    expect(settlementProjection).toMatchObject({
      workType: "EXIT_SETTLEMENT_BOUND",
      coveredByTaskIds: supplementalTaskIds,
      requiresSupplementalTask: true,
    });
    expect(registry.summary.scoreProjectionReasonNeedingSupplementCount).toBe(1);
  });

  it("does not turn explicitly non-curation structural risk into a missing-data task", () => {
    expect(classifyV9ScoreProjectionWorkType("correlated-exit-routes")).toBeNull();
  });

  it("fails closed when a score projection reason has no typed routing metadata", () => {
    expect(() => classifyV9ScoreProjectionWorkType("unregistered-projection-reason")).toThrow(
      /Missing agent work-type definition/,
    );
  });

  it.each([
    ["fiat-cash", "claimAndSegregation"],
    ["fiat-cash", "custodyContinuity"],
    ["fiat-cash", "assuranceAndReconciliation"],
    ["tbill", "fundClaimAndSeniority"],
    ["tbill", "navValuation"],
    ["tbill", "durationAndLiquidity"],
    ["tbill", "lossRecoveryDesign"],
    ["commodity-claim", "titleAndAllocation"],
    ["commodity-claim", "custodyContinuity"],
    ["commodity-claim", "assuranceAndReconciliation"],
    ["commodity-claim", "physicalRedemption"],
  ] as const)("routes ratified %s %s evidence to agent curation", (archetype, componentKey) => {
    expect(
      mechanismResolutionMode({
        archetype,
        path: { kind: "local-component", componentKey: `mechanism-review:${componentKey}` },
      } as Parameters<typeof mechanismResolutionMode>[0]),
    ).toBe("agent-curation");
  });

  it("keeps advanced-archetype mechanism gaps on measured evidence routes", () => {
    expect(
      mechanismResolutionMode({
        archetype: "rwa-credit-fund",
        path: { kind: "local-component", componentKey: "mechanism-review:seniority" },
      } as Parameters<typeof mechanismResolutionMode>[0]),
    ).toBe("issuer-or-onchain-evidence");
  });

  it.each(["fiat-cash", "tbill", "commodity-claim"] as const)(
    "routes %s score-projection mechanism gaps to agent curation",
    (archetype) => {
      expect(scoreProjectionResolutionMode("MECHANISM_REVIEW", archetype)).toBe("agent-curation");
    },
  );

  it("directs mechanism review work to the overlay under the ratified evidence standard", () => {
    expect(
      likelyTouchpoints(
        "MECHANISM_REVIEW",
        {
          file: "shared/data/stablecoins/coins/fixture.json",
          sidecarFiles: ["shared/data/stablecoins/domains/reserves/fixture.json"],
        },
        null,
      ),
    ).toEqual([
      "shared/data/safety-score-v9/mechanism-review-overlays-v1.json",
      "shared/data/stablecoins/coins/fixture.json",
    ]);
  });
});
