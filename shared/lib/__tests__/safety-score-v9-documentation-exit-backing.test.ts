/**
 * Exit/backing documentation class (PLAN §2.3/§4.3, ImplDocExitBacking §6).
 *
 * The class is derived-only (decision B), so every test here checks a boundary
 * between what DOC-1's classifier may label and what the scorer actually prices:
 * the 3f dust bar against the weight the reserve blend already reads, the 3d
 * zero-route/empty-inventory floor, the 3b route-admission veto against the
 * routes `evaluateV9Exit` admits, and the per-root dust residual identity.
 * Classification is never allowed to mutate a fact set, a weight or a
 * contribution.
 */

import { describe, expect, it } from "vitest";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import {
  classifyV9DocumentationGap,
  documentationGapIds,
  type V9DocumentationAssetFacts,
} from "../safety-score-v9/documentation";
import { evaluateV9Exit } from "../safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { createV9FactGapV3 } from "../safety-score-v9/reasons";
import { stableJsonStringifyV1 } from "../stable-json";
import type { V9EvidenceCauseProof } from "../../types/safety-score-v9-causes";
import type { V9EvidenceGapQueueEntryV3 } from "../../types/safety-score-v9-evidence-queue";
import type {
  V9AssetFactsV3,
  V9FactGapV3,
  V9ReserveExposureFactV2,
} from "../../types/safety-score-v9-facts";
import {
  documentationResidualForRoot,
  documentationResidualQuestionKey,
} from "../../../scripts/maintenance/generate-safety-score-v9-missing-data-registry";
import { asset, exposure, knownStatus } from "./safety-score-v9-backing.test-support";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";
import { compileNativeV3FactSet, coreFixture } from "./safety-score-v9-facts.fixture-support";

const POLICY = V9_CANDIDATE_POLICY_V1;
const DOCUMENTATION = POLICY.policy.semantic.evidence.documentation;
if (DOCUMENTATION === undefined) throw new Error("The candidate policy must author the documentation block");
const baseFacts = compileNativeV3FactSet(coreFixture()).assets.find((entry) => entry.assetId === "alpha") as V9AssetFactsV3;

const UNRESEARCHED = { cause: "U", reason: "not-yet-researched", evidenceRefIds: [] as [] } satisfies V9EvidenceCauseProof;

/** The classifier reads these fields; other fixtures supply the rest. */
function factsFor(
  overrides: Partial<V9DocumentationAssetFacts> & Pick<V9DocumentationAssetFacts, "gaps">,
): V9DocumentationAssetFacts {
  return {
    assetId: baseFacts.assetId,
    archetype: baseFacts.archetype,
    controlStatus: baseFacts.controlStatus,
    controls: [],
    supply: baseFacts.supply,
    economicControlReview: baseFacts.economicControlReview,
    reserveExposures: [],
    exitRoutes: baseFacts.exitRoutes,
    ...overrides,
  };
}

function reserveFactorGap(gapId: string, exposureKey: string): V9FactGapV3 {
  return createV9FactGapV3({
    gapId,
    reasonCode: "material-reserve-slice-unstructured",
    ownerDomain: "backing",
    policyRuleId: "v9.backing.reserve-composition",
    observationState: "missing",
    responsibility: "unresearched",
    path: { kind: "collateral-exposure", exposureKey },
    message: "The exact reserve factor is missing.",
    causeProof: UNRESEARCHED,
    causeScope: {
      pillar: "backing",
      componentKey: "reserve-residual",
      factorKey: "liquidity",
      routeKey: null,
      exposureId: exposureKey,
      requiredDatum: "reserveClassification",
    },
  });
}

/** The reserve row the scorer blends, with the gap that makes the factor missing. */
function missingExposure(key: string, weight: number, gapId: string): V9ReserveExposureFactV2 {
  const row = exposure({ key, weight });
  return {
    ...row,
    status: { ...knownStatus(`attempt:${key}`), observationState: "missing", evidenceRefIds: [], gapIds: [gapId] },
  };
}

function coverageGap(): V9FactGapV3 {
  return createV9FactGapV3({
    gapId: "alpha:gap:exit-portfolio-coverage",
    reasonCode: "incomplete-dex-route-coverage",
    ownerDomain: "exit",
    policyRuleId: "v9.exit.same-notional-route",
    observationState: "bounded-unknown",
    responsibility: "producer-failed",
    path: { kind: "local-component", componentKey: "exit-portfolio-coverage" },
    message: "The DEX exit surface is not fully observed.",
    causeProof: UNRESEARCHED,
    causeScope: {
      pillar: "exit",
      componentKey: "exit-portfolio-coverage",
      factorKey: null,
      routeKey: null,
      exposureId: null,
      requiredDatum: "dex-route-coverage",
    },
  });
}

function unresolvedOutputGap(routeKey: string): V9FactGapV3 {
  return createV9FactGapV3({
    gapId: `alpha:gap:route:${routeKey}:output`,
    reasonCode: "unresolved-exit-output",
    ownerDomain: "exit",
    policyRuleId: "v9.exit.same-notional-route",
    observationState: "missing",
    responsibility: "unresearched",
    path: { kind: "optional-exit", routeKey },
    message: "The route output is unresolved.",
    causeProof: UNRESEARCHED,
    causeScope: {
      pillar: "exit",
      componentKey: `exit-route:${routeKey}`,
      factorKey: "output",
      routeKey,
      exposureId: null,
      requiredDatum: "output",
    },
  });
}

/** The routes `evaluateV9Exit` actually admitted; the 3b veto reads the same set. */
function admittedRouteKeys(args: Parameters<typeof evaluateV9Exit>[0]): ReadonlySet<string> {
  return new Set(evaluateV9Exit(args, POLICY).routes
    .filter((route) => route.included)
    .map((route) => route.routeKey));
}

describe("Safety Score v9 reserve dust documentation (3f)", () => {
  it("classifies strictly below 1e-4 of the book and leaves the bar itself priced", () => {
    expect(DOCUMENTATION.reserveDustBookSharePct).toBe(0.01);
    const dust = reserveFactorGap("alpha:gap:reserve:dust:liquidity", "exposure:dust");
    const atBar = reserveFactorGap("alpha:gap:reserve:at-bar:liquidity", "exposure:at-bar");
    const above = reserveFactorGap("alpha:gap:reserve:above:maturity", "exposure:above");
    const facts = factsFor({
      gaps: [dust, atBar, above],
      reserveExposures: [
        exposure({ key: "exposure:cash", weight: 0.9 }),
        missingExposure("exposure:dust", 0.00009999, dust.gapId),
        missingExposure("exposure:at-bar", 0.0001, atBar.gapId),
        missingExposure("exposure:above", 0.0002, above.gapId),
      ],
    });

    const classification = classifyV9DocumentationGap(POLICY, facts, dust);
    expect(classification).toEqual({
      reason: "reserve-dust",
      policyRef: "semantic.evidence.documentation.reasons.reserve-dust",
      threshold: { kind: "reserve-book-share", value: 0.0001 },
    });
    expect(classifyV9DocumentationGap(POLICY, facts, atBar)).toBeNull();
    expect(classifyV9DocumentationGap(POLICY, facts, above)).toBeNull();
    expect([...documentationGapIds(POLICY, facts).keys()]).toEqual([dust.gapId]);

    // The same weight the classifier compares is the weight the blend reads.
    const priced = evaluateV9ReserveExposures(asset(facts.reserveExposures, facts.gaps), POLICY);
    expect(priced.contributions.find((row) => row.componentKey === "reserve:exposure:dust")?.wholeAssetWeight)
      .toBe(0.00009999);
    expect(priced.contributions.find((row) => row.componentKey === "reserve:exposure:at-bar")?.wholeAssetWeight)
      .toBe(0.0001);
  });

  it("keeps every reserve contribution and the input byte-identical across classification", () => {
    const dust = reserveFactorGap("alpha:gap:reserve:dust:liquidity", "exposure:dust");
    const known = reserveFactorGap("alpha:gap:reserve:row:liquidity", "exposure:row");
    const reserveExposures = [
      exposure({ key: "exposure:cash", weight: 0.7 }),
      missingExposure("exposure:dust", 0.00009, dust.gapId),
      missingExposure("exposure:row", 0.29991, known.gapId),
    ];
    const input = asset(reserveExposures, [dust, known]);
    const inputBefore = stableJsonStringifyV1(input);
    const before = evaluateV9ReserveExposures(input, POLICY);
    expect(before.contributions.map((row) => row.componentKey)).toContain("reserve:exposure:dust");

    const facts = factsFor({ gaps: [dust, known], reserveExposures });
    expect([...documentationGapIds(POLICY, facts).keys()]).toEqual([dust.gapId]);

    // Deriving the class must not re-price, re-cause or re-identify the blend.
    const after = evaluateV9ReserveExposures(input, POLICY);
    expect(after).toEqual(before);
    expect(stableJsonStringifyV1(input)).toBe(inputBefore);
    expect(after.contributions.find((row) => row.componentKey === "reserve:exposure:dust"))
      .toMatchObject({ wholeAssetWeight: 0.00009, scoringDisposition: before.contributions
        .find((row) => row.componentKey === "reserve:exposure:dust")?.scoringDisposition });
  });
});

describe("Safety Score v9 exit coverage documentation (3d)", () => {
  it("classifies the portfolio coverage label only when the inventory has routes", () => {
    const gap = coverageGap();
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap] }), gap)?.reason).toBe("coverage-label");
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap], exitRoutes: [] }), gap)).toBeNull();
  });

  it("never prices the coverage label and keeps the same routes scored", () => {
    const gap = coverageGap();
    const route = makeExitRoute();
    const reviewed = evaluateV9Exit({
      circulatingUsd: 5_000_000,
      portfolioStatus: "reviewed-complete",
      portfolioFactStatus: knownStatus("dex-census"),
      routes: [route],
    }, POLICY);
    const incomplete = evaluateV9Exit({
      circulatingUsd: 5_000_000,
      portfolioStatus: "incomplete",
      portfolioFactStatus: {
        ...knownStatus("dex-census"),
        observationState: "bounded-unknown",
        evidenceRefIds: [],
        gapIds: [gap.gapId],
      },
      gaps: [gap],
      routes: [route],
    }, POLICY);

    expect(incomplete.routes).toEqual(reviewed.routes);
    expect(incomplete.score).toBe(reviewed.score);
    expect(incomplete.causeGapIds).toContain(gap.gapId);
  });

  it("keeps the zero-route inventory open because completing coverage there arms the adverse floor", () => {
    const gap = coverageGap();
    const provenEmpty = evaluateV9Exit({
      circulatingUsd: 5_000_000,
      portfolioStatus: "reviewed-complete",
      portfolioFactStatus: knownStatus("dex-census"),
      routes: [],
    }, POLICY);
    const undocumented = evaluateV9Exit({
      circulatingUsd: 5_000_000,
      portfolioStatus: "incomplete",
      portfolioFactStatus: {
        ...knownStatus("dex-census"),
        observationState: "bounded-unknown",
        evidenceRefIds: [],
        gapIds: [gap.gapId],
      },
      gaps: [gap],
      routes: [],
    }, POLICY);

    // A reviewed census proving no routes exist is adverse (0), not unknown:
    // resolving the coverage datum on this asset can only add that adverse fact.
    expect(provenEmpty.score).toBe(0);
    expect(provenEmpty.aggregationDisposition).toBe("included");
    expect(undocumented.score).not.toBe(0);
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap], exitRoutes: [] }), gap)).toBeNull();
  });
});

describe("Safety Score v9 route-scoped diagnostic veto (3b)", () => {
  it("classifies a route-scoped diagnostic only on a route the evaluator admitted", () => {
    const routeKey = "redemption:issuer";
    const gap = unresolvedOutputGap(routeKey);
    const excluded = admittedRouteKeys({
      circulatingUsd: 5_000_000,
      portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute({ outputResolved: false })],
      gaps: [gap],
    });
    const admitted = admittedRouteKeys({
      circulatingUsd: 5_000_000,
      portfolioStatus: "reviewed-complete",
      routes: [makeExitRoute()],
      gaps: [gap],
    });

    expect(excluded.has(routeKey)).toBe(false);
    expect(admitted.has(routeKey)).toBe(true);
    // On an unscored route the datum still gates admission, so it stays required.
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap], admittedExitRouteKeys: excluded }), gap))
      .toBeNull();
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap], admittedExitRouteKeys: admitted }), gap)?.reason)
      .toBe("unscored-diagnostic");
    // Unknown admission fails closed.
    expect(classifyV9DocumentationGap(POLICY, factsFor({ gaps: [gap] }), gap)).toBeNull();
  });
});

describe("Safety Score v9 reserve dust residual (3f merge layer)", () => {
  type ResidualEntry = Pick<V9EvidenceGapQueueEntryV3, "gapId" | "path" | "materiality">;
  const residualEntry = (root: string, exposureKey: string, gapId: string, weight: number): ResidualEntry => ({
    gapId: `${root}:gap:reserve:${exposureKey}:${gapId}`,
    path: { kind: "collateral-exposure", exposureKey: `reserve:${exposureKey}` },
    materiality: { basis: "collateral-exposure", fractionOfAsset: weight },
  });

  it("merges one residual question per root and keeps every datum addressable", () => {
    expect(DOCUMENTATION.reserveDustResidualMaxBookSharePct).toBe(0.1);
    const alphaEntries = [
      residualEntry("alpha", "row-a", "liquidity", 0.00004),
      residualEntry("alpha", "row-b", "maturity", 0.00005),
    ];
    const betaEntries = [residualEntry("beta", "row-c", "liquidity", 0.00002)];
    const taskIds = new Map([...alphaEntries, ...betaEntries].map((entry, index) => [entry.gapId, `task-${index}`]));
    const residualMax = DOCUMENTATION.reserveDustResidualMaxBookSharePct;

    const groups = [
      { root: "alpha", entries: alphaEntries },
      { root: "beta", entries: betaEntries },
    ];
    const residuals = groups.map(({ root, entries }) =>
      documentationResidualForRoot(root, entries, taskIds, residualMax));

    expect(residuals.map((residual) => residual.questionKey))
      .toEqual(groups.map(({ root }) => documentationResidualQuestionKey(root)));
    expect(new Set(residuals.map((residual) => residual.questionKey)).size).toBe(2);
    for (const residual of residuals) {
      expect(residual.bucket).toBe("documentation");
      expect(residual.thresholdBookSharePct).toBe(0.1);
      expect(residual.datumGapIds).toHaveLength(residual.datumCount);
      expect(residual.datumTaskIds).toHaveLength(residual.datumCount);
      expect(residual.datumGapIds.every((gapId) => taskIds.has(gapId))).toBe(true);
    }
    // The merged rows keep their exposure identities; nothing is dropped.
    expect(residuals[0]!.exposureKeys).toEqual(["reserve:row-a", "reserve:row-b"]);
    expect(residuals[0]!.datumGapIds).toEqual([...residuals[0]!.datumGapIds].sort());
  });

  it("returns the merged residual to the open band at the 0.1% book bar", () => {
    const below = [residualEntry("alpha", "row-a", "liquidity", 0.0009)];
    const atBar = [residualEntry("alpha", "row-a", "liquidity", 0.001)];
    const residualMax = DOCUMENTATION.reserveDustResidualMaxBookSharePct;
    expect(documentationResidualForRoot("alpha", below, new Map(), residualMax).bucket).toBe("documentation");
    expect(documentationResidualForRoot("alpha", atBar, new Map(), residualMax).bucket).toBe("open");
  });
});
