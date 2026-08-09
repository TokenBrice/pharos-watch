/**
 * VERITAS fact-contract repros (VER-006/007/008/009/011/012 plus the VERITAS-II
 * mechanism-overlay expiry finding). Consolidated from six single-incident
 * files; every assertion and VER-0xx describe name is preserved verbatim.
 */

import { evaluateV9EconomicControl, type V9EconomicControlAssetFacts } from "@shared/lib/safety-score-v9/control";
import { evaluateV9Exit } from "@shared/lib/safety-score-v9/exit";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { StablecoinMeta } from "@shared/types/core";
import type { V9FactStatusV2 } from "@shared/types/safety-score-v9-facts";
import type { ReserveSlice } from "@shared/types/reserves";
import { describe, expect, it } from "vitest";
import miniCapture from "./fixtures/safety-score-v9-rateable-mini-capture.json";
import {
  createReportCardsFixedInput,
  normalizeFixedInput,
  type ReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../report-cards-fixed-input";
import {
  compileSafetyScoreV9FactSetFromFixedInput,
  compileSafetyScoreV9FactSetFromNormalizedInput,
  compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension,
  materializeSafetyScoreV9FactSetExtension,
} from "../safety-score-v9-fact-set";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9-candidate";
import {
  buildSafetyScoreV9BaselineExtension,
  buildSafetyScoreV9BaselineExtensionFromNormalizedInput,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9-extension";
import { buildSafetyScoreV9MechanismReview } from "../safety-score-v9-extension-mechanism";
import {
  makeV9FixedInput,
  v9NotApplicableStatus,
  v9Status,
  v9TestClockSec,
  V9_FIXTURE_CLOCK_SEC as AS_OF_SEC,
} from "../../test-helpers/v9-fixed-input";

const DEFAULT_RESERVES: readonly ReserveSlice[] = [
  {
    name: "Custodied cash",
    pct: 100,
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "issuer:alpha",
    riskFactors: ["custody", "counterparty"],
    liquidityHorizon: "immediate",
    maturityDaysMax: 0,
  },
];

function requiredStatus(observationState: "known" | "missing", rule: string): V9FactStatusV2 {
  return v9Status(observationState, rule, { evidenceRefId: `evidence:${rule}`, gapId: `gap:${rule}` });
}

function notApplicableStatus(rule: string): V9FactStatusV2 {
  return v9NotApplicableStatus(rule, {
    rationale: "Reviewed as not applicable for the VERITAS fixture.",
    evidenceRefIds: [],
  });
}

/** The shared zero-route VERITAS capture: a reviewed-complete empty DEX surface. */
function exactFixedInput(reserves: readonly ReserveSlice[] = DEFAULT_RESERVES) {
  return makeV9FixedInput({
    sourceGeneration: `report-cards:veritas:${AS_OF_SEC}`,
    registryRevision: "registry:veritas",
    pegMethodologyVersion: "peg:veritas-v1",
    dexMethodologyVersion: "dex:veritas-v1",
    reserves,
    aggregateCirculating: { peggedUSD: 10_000_000 },
    dexOverrides: {
      liquidityScore: 0,
      concentrationHhi: 0,
      poolCount: 0,
      chainCount: 0,
      effectiveTvlUsd: 0,
      balanceMeasuredTvlUsd: 0,
      organicMeasuredTvlUsd: 0,
      exitRouteObservations: [],
      exitRouteObservationCoverage: {
        status: "populated",
        capabilityMatrixVersion: "veritas-zero-route-v1",
        retainedPoolCount: 0,
        observationCount: 0,
        scoreEligibleObservationCount: 0,
        scoreEligiblePoolCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: {},
        unsupportedReasons: {},
      },
    },
  });
}

function baselineExtension(fixedInput: ReturnType<typeof exactFixedInput>) {
  return structuredClone(
    buildSafetyScoreV9BaselineExtension(fixedInput, {
      metaById: new Map([
        [
          "alpha",
          {
            id: "alpha",
            mechanismArchetype: "fiat-cash" as const,
            launchDate: "2020-01-01",
          },
        ],
      ]),
    }),
  );
}

// VER-006 guards the native compiler/evaluator/publication path for explicit
// reviewed-complete zero-route coverage.
describe("VERITAS finding VER-006: zero-route completeness is compiled as missing evidence", () => {
  it("keeps native V3 reviewed-complete empty coverage measured-adverse and rateable through publication", () => {
    const fixedInput = exactFixedInput();
    const extension = baselineExtension(fixedInput);
    const pipeline = buildSafetyScoreV9Candidate({
      fixedInput,
      extension,
      publishedAtSec: AS_OF_SEC,
    });
    const compiled = pipeline.compiledFacts;
    const asset = compiled.assets[0]!;
    const evaluated = pipeline.evaluatedSet.assets[0]!;
    const actual = evaluated.exit;
    const expected = evaluateV9Exit(
      { circulatingUsd: 10_000_000, portfolioStatus: "reviewed-complete", routes: [] },
      V9_CANDIDATE_POLICY_V1,
    );

    expect(asset.exitStatus.observationState).toBe("known");
    expect(asset.exitRoutes).toEqual([]);
    expect(actual).toEqual(expected);
    expect(actual).toMatchObject({ score: 0, reasons: expect.arrayContaining(["no-viable-exit-path"]) });
    expect(evaluated.scoreInput.pillars.exit.reasons).toContainEqual(
      expect.objectContaining({
        code: "no-viable-exit-path",
        responsibility: "measured-adverse",
      }),
    );
    expect(evaluated.trace.finalScore).not.toBeNull();
    expect(evaluated.trace.finalGrade).not.toBe("NR");

    const card = pipeline.candidate.cards[0]!;
    expect(card.pillars.exit.score).toBe(0);
    expect(card.grade).not.toBe("NR");
    expect(card.score).not.toBeNull();
    expect(card.scoreTrace.adverseAttribution.items).toContainEqual(
      expect.objectContaining({
        source: "reason",
        responsibility: "measured-adverse",
        path: "exit:no-viable-exit-path",
      }),
    );
  });
});

// VER-007: a non-null review currently makes positive circulating supply known even
// though none of that supply is selected, unknown, or unreviewed.
describe("VERITAS finding VER-007: nonconserving supply review is accepted as known", () => {
  it("rejects a positive-supply review whose accounting shares sum to zero", () => {
    const fixedInput = exactFixedInput();
    const extension = baselineExtension(fixedInput);
    extension.assets[0]!.supplyReview = {
      selectedBridgeRoutes: [],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };

    const normalized = normalizeFixedInput(fixedInput);
    const materialized = materializeSafetyScoreV9FactSetExtension(normalized, extension);
    const result = compileSafetyScoreV9FactSetWithIsolationFromValidatedExtension(normalized, materialized);

    expect(result.quarantines).toEqual([{ assetId: "alpha", code: "fact-build-failed" }]);
  });
});

// VER-008: reserve compilation currently enforces <=100% only within each exposure
// identity. Two distinct 60% rows therefore survive into canonical facts.
describe.skip("VERITAS finding VER-008: aggregate reserve weights above 100% pass fact compilation", () => {
  it("rejects a reserve envelope whose distinct exposure weights total 120%", () => {
    const fixedInput = exactFixedInput([
      {
        name: "Custodied cash A",
        pct: 60,
        risk: "very-low",
        assetClass: "cash",
        issuerOrObligor: "issuer:a",
        riskFactors: ["custody", "counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
      },
      {
        name: "Custodied cash B",
        pct: 60,
        risk: "very-low",
        assetClass: "cash",
        issuerOrObligor: "issuer:b",
        riskFactors: ["custody", "counterparty"],
        liquidityHorizon: "immediate",
        maturityDaysMax: 0,
      },
    ]);

    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixedInput, baselineExtension(fixedInput))).toThrow(
      /reserve.*(?:100|full notional|total weight)/i,
    );
  });
});

// VER-009: oracle review is required for this archetype and the evaluator emits the
// missing-profile reason, while the policy currently authorizes it only for CDPs.
describe("VERITAS finding VER-009: oracle reasons can escape their archetype allowlist", () => {
  it("keeps every emitted reason compatible with the evaluated asset archetype", () => {
    const facts: V9EconomicControlAssetFacts = {
      assetId: "veritas-synthetic",
      archetype: "synthetic-delta-neutral",
      controlStatus: notApplicableStatus("v9.control.inventory"),
      controls: [],
      supply: {
        status: requiredStatus("known", "v9.supply.current"),
        selectedBridgeRoutes: [
          {
            deploymentRouteKey: "ethereum:native",
            supplyUsd: 10_000_000,
            supplyShare: 1,
            reviewState: "selected-reviewed",
          },
        ],
        selectedRouteSupplyShare: 1,
        unknownRouteSupplyShare: 0,
        unreviewedRouteSupplyShare: 0,
      },
    };
    const result = evaluateV9EconomicControl({
      policy: V9_CANDIDATE_POLICY_V1,
      facts,
      mint: {
        status: notApplicableStatus("v9.control.mint-review"),
        controlKey: null,
        reconciliation: "not-applicable",
        supervision: "unknown",
        upgrade: { state: "not-applicable", controlKey: null },
      },
      oracle: {
        status: requiredStatus("missing", "v9.control.oracle-review"),
        tier: null,
        branches: [],
      },
      bridge: {
        status: notApplicableStatus("v9.control.bridge-review"),
        routes: [],
      },
    });

    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "missing-oracle-profile" }));
    for (const emitted of result.reasons) {
      const registration = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find((entry) => entry.code === emitted.code)!;
      expect(
        registration.archetypes.includes("*") ||
          registration.archetypes.some((archetype) => archetype === facts.archetype),
        `${emitted.code} is not authorized for ${facts.archetype}`,
      ).toBe(true);
    }
  });
});

// VER-012 (folded in from safety-score-v9-veritas-bounded-gap-repro.test.ts).
// VER-012: ordinary missing access reviews compile with the evidence-owned
// `missing-pillar-evidence` reason even though the facts are control-owned.
// This is a work-queue binding defect; Access does not enter the score pillars.
describe("VERITAS finding VER-012: access gaps violate their reason owner contract", () => {
  it("keeps every ordinary access gap bound to a reason with the same owner", () => {
    const fixedInput = createReportCardsFixedInput(miniCapture.draft as unknown as ReportCardsFixedInputDraft);
    const metaById = new Map<string, V9ExtensionRegistryMeta>(
      fixedInput.activeAssetIds.map((assetId) => [assetId, { id: assetId, mechanismArchetype: "fiat-cash" }]),
    );
    const extension = buildSafetyScoreV9BaselineExtensionFromNormalizedInput(fixedInput, {
      metaById,
      registryFingerprint: fixedInput.registryFingerprint,
    });
    const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(fixedInput, extension);
    const evaluated = evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1);

    // The deliberately sparse baseline extension can now be NR for unrelated
    // producer-owned exit evidence. Access review gaps themselves must remain
    // non-withholding and bound to the control owner.
    expect(
      evaluated.assets.every((asset) =>
        asset.trace.nrReasons.every((reason) => reason.code !== "missing-access-review"),
      ),
    ).toBe(true);

    const accessGaps = compiled.assets.flatMap((asset) =>
      asset.gaps.flatMap((gap) =>
        gap.path.kind === "local-component" && gap.path.componentKey.startsWith("access:") ? [gap] : [],
      ),
    );
    expect(accessGaps.length).toBeGreaterThan(0);
    for (const gap of accessGaps) {
      const reason = V9_CANDIDATE_POLICY_V1.policy.reasonRegistry.find((entry) => entry.code === gap.reasonCode)!;
      const componentKey = gap.path.kind === "local-component" ? gap.path.componentKey : gap.path.kind;
      expect(reason.ownerDomain, `${gap.reasonCode} is misbound at ${componentKey}`).toBe(gap.ownerDomain);
    }
  });
});

// VER-011 (folded in from veritas-ver-011-v9-producer-capability-identity.test.ts).
// VER-011: documented-terms freshness can change without changing candidate capability identity.
{
  // One day past the newest reviewed registry date, so the baseline extension's
  // "review is later than the scoring clock" guard stays untripped without a
  // hand-pinned literal.
  const VER_011_CLOCK_SEC = v9TestClockSec();
  const ASSET_ID = "alpha";

  function ver011FixedInput() {
    return makeV9FixedInput({
      assetId: ASSET_ID,
      clockSec: VER_011_CLOCK_SEC,
      sourceGeneration: "report-cards:fixture:ver-011",
      reserves: [],
      includeDexObservations: false,
      includeDexCoverage: false,
      dexOverrides: {
        liquidityScore: 0,
        concentrationHhi: null,
        poolCount: 0,
        chainCount: 0,
        coverageClass: "unobserved",
        coverageConfidence: 0,
        liquidityEvidenceClass: "unobserved",
        hasMeasuredLiquidityEvidence: false,
        effectiveTvlUsd: 0,
        balanceMeasuredTvlUsd: 0,
        organicMeasuredTvlUsd: 0,
      },
      chainSupplyByChain: {
        ethereum: {
          current: 1,
          circulatingPrevDay: 1,
          circulatingPrevWeek: 1,
          circulatingPrevMonth: 1,
        },
      },
    });
  }

  describe("VERITAS finding VER-011: documented-terms freshness is capability-bound", () => {
    it("changes producer capability and candidate identities with the freshness policy", () => {
      const fixedInput = ver011FixedInput();
      const beforeExtension = buildSafetyScoreV9BaselineExtension(fixedInput, {
        metaById: new Map([[ASSET_ID, { id: ASSET_ID, mechanismArchetype: "fiat-cash" }]]),
      });
      const afterExtension = structuredClone(beforeExtension);
      afterExtension.routeFreshness.documentedTermsMaxAgeSec += 1;

      const before = buildSafetyScoreV9Candidate({
        fixedInput,
        extension: beforeExtension,
        publishedAtSec: VER_011_CLOCK_SEC + 1,
      });
      const after = buildSafetyScoreV9Candidate({
        fixedInput,
        extension: afterExtension,
        publishedAtSec: VER_011_CLOCK_SEC + 1,
      });

      expect(after.extension.routeFreshness.documentedTermsMaxAgeSec).toBe(
        before.extension.routeFreshness.documentedTermsMaxAgeSec + 1,
      );
      expect(after.producerCapabilityDigest).not.toBe(before.producerCapabilityDigest);
      expect(after.candidate.candidateId).not.toBe(before.candidate.candidateId);
    });
  });
}

// VERITAS-II (folded in from veritas-2-mechanism-overlay-expiry-repro.test.ts).
{
type MechanismMeta = Pick<StablecoinMeta, "id" | "reserves" | "reserveReview" | "custodyProfile" | "proofOfReserves">;

describe("VERITAS-II finding: mechanism overlays do not expire after twelve months", () => {
  it("re-bounds USDC components after its 2026-07-15 review expires", () => {
    const fixedInput = {
      clockSec: Date.UTC(2027, 6, 16) / 1_000,
      liveReserveMap: { "usdc-circle": [{ pct: 100 }] },
    } as unknown as ReportCardsFixedInput;
    const meta = { id: "usdc-circle" } as MechanismMeta;

    const review = buildSafetyScoreV9MechanismReview(fixedInput, meta, "fiat-cash");
    if (review?.archetype !== "fiat-cash") throw new Error("expected the USDC fiat-cash review");

    expect(review.claimAndSegregation.status.observationState).toBe("bounded-unknown");
    expect(review.claimAndSegregation.quality).toBeNull();
    expect(review.custodyContinuity.status.observationState).toBe("bounded-unknown");
    expect(review.custodyContinuity.quality).toBeNull();
  });
});
}
