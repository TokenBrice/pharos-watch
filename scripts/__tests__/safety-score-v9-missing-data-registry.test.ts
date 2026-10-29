import policyAsset from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import {
  compileNativeV3FactSet,
  coreFixture,
  createV9FactGap,
  createV9FactStatus,
  requiredV9Applicability,
  minimalAsset,
} from "@shared/lib/__tests__/safety-score-v9-facts.fixture-support";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { loadV9MethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { V9_MECHANISM_FIELDS } from "@shared/lib/safety-score-v9/mechanism-fields";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Pillars,
  makeReportCardsV9PipelineGapCard,
} from "@shared/test-utils/report-cards-v9";
import { makeCoin } from "./stablecoin-catalog.test-support";
import { describe, expect, it } from "vitest";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import {
  generateV9MissingDataRegistry,
  classifyV9ScoreProjectionWorkType,
  mechanismOverlayAdmissionWarnings,
} from "../maintenance/generate-safety-score-v9-missing-data-registry";
import {
  descriptorForReason,
  workTypeForDescriptor,
} from "../lib/safety-score-v9-missing-data-work-types";

const SHARED_EXIT_MESSAGE = "Comparable exit route evidence is missing for the reviewed settlement window of this fixture.";

it("warns only before each mechanism review's admission instant", () => {
  const clockSec = Date.parse("2026-10-18T12:00:00Z") / 1_000;
  const fixture = (reviewedAt: string, componentReviewedAt?: string) => [{
    assetId: "fixture", reviewedAt, components: {
      claim: componentReviewedAt ? { review: { reviewedAt: componentReviewedAt } } : {},
    },
  }];
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-18"))).toHaveLength(1);
  expect(mechanismOverlayAdmissionWarnings(clockSec + 43_200, fixture("2026-10-18"))).toHaveLength(0);
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-18T11:00:00Z"))).toHaveLength(0);
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-18T12:00:00Z"))).toHaveLength(0);
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-18T12:00:00.125Z"))).toHaveLength(1);
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-01", "2026-10-18"))).toHaveLength(1);
  expect(mechanismOverlayAdmissionWarnings(clockSec, fixture("2026-10-01", "2026-10-18T12:00:00Z"))).toHaveLength(0);
});

function generateExitProjectionFixture(
  reasonCodes: readonly ("unproven-settlement-bound" | "unsupported-same-notional-route")[],
  options: { intern?: boolean; gapCount?: number; contextKeys?: readonly string[] } = {},
) {
  const assetId = "exit-fixture";
  const core = coreFixture();
  const asset = minimalAsset(assetId);
  const gapId = `${assetId}:gap:exit-portfolio-coverage`;
  const gapCount = options.gapCount ?? options.contextKeys?.length ?? 1;
  asset.gaps = Array.from({ length: gapCount }, (_, index) =>
    createV9FactGap({
      gapId: gapCount === 1 ? gapId : `${gapId}:${"measured-deployment-".repeat(16)}${String(index).padStart(3, "0")}`,
      reasonCode: "incomplete-dex-route-coverage",
      ownerDomain: "exit",
      policyRuleId: "v9.exit.same-notional-route",
      observationState: "bounded-unknown",
      path: { kind: "local-component", componentKey: options.contextKeys?.[index] ?? "exit-portfolio-coverage" },
      message: "Reviewed DEX pools do not all carry score-eligible exact route observations.",
      evidenceRefIds: ["evidence:base"],
    }),
  );
  asset.exitStatus = createV9FactStatus({
    applicability: requiredV9Applicability("v9.exit.same-notional-route"),
    observationState: "bounded-unknown",
    evidenceRefIds: ["evidence:base"],
    gapIds: asset.gaps.map(gap => gap.gapId),
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
    message: options.intern ? SHARED_EXIT_MESSAGE : `${code} fixture`,
  }));
  const plainCard = makeReportCardsV9Card({
    id: assetId,
    pillars,
    reasonCodes: [...reasonCodes].sort(),
  });
  const card = options.intern ? internV9PublicWitnessTexts(plainCard) : plainCard;

  return generateV9MissingDataRegistry({
    replay: {
      pipeline: {
        compiledFacts,
        candidate: {
          model: "v9-critical-path",
          schemaVersion: 8,
          openEvidence: EMPTY_OPEN_EVIDENCE,
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
            pipelineGapCount: 0,
            pipelineGapIds: [],
          },
          foreignCauseGaps: [],
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

/** Schema-valid empty block: these fixtures exercise routing, not open-evidence counts. */
const EMPTY_OPEN_EVIDENCE = {
  semantics: "open-question-v1" as const,
  totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 },
  owners: [],
  reasons: [],
  documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
  issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
  byCard: [],
};

describe("Safety Score v9 missing-data work routing", () => {
  it.each([...new Set(Object.values(V9_MECHANISM_FIELDS).flatMap(({ components }) =>
    components.map(([, field]) => field),
  ))])("routes missing and bounded mechanism evidence for %s to the mechanism work type", (field) => {
    const path = { kind: "local-component" as const, componentKey: `mechanism-review:${field}` };
    for (const reason of ["missing-pillar-evidence", "bounded-mechanism-review"]) {
      const descriptor = descriptorForReason(reason, path);
      expect(workTypeForDescriptor(descriptor)).toBe("MECHANISM_REVIEW");
      expect(descriptor.defaultResolutionMode).toBe("issuer-or-onchain-evidence");
      expect(descriptor.context(minimalAsset("mechanism-fixture") as unknown as V9AssetFactsV3)).toMatchObject({
        componentKey: field,
      });
    }
  });

  it("routes missing nested mechanism constraints without weakening unknown-component failures", () => {
    const descriptor = descriptorForReason("missing-pillar-evidence", {
      kind: "local-component", componentKey: "mechanism-review:fundClaimAndSeniority:legal-claim",
    });
    expect(workTypeForDescriptor(descriptor)).toBe("MECHANISM_REVIEW");
    expect(() => descriptorForReason("missing-pillar-evidence", {
      kind: "local-component", componentKey: "unregistered-component",
    })).toThrow(/Missing agent work-type definition/);
  });

  it.each([false, true])("reconciles rated, economic NR and pipeline-gap census (gap-only=%s)", (gapOnly) => {
    const cards = [
      ...(gapOnly ? [] : [
        makeReportCardsV9Card({ id: "economic-nr", score: null, nrReasons: [{
          code: "insufficient-evidence", field: null, message: "Economic evidence remains unresolved.", origin: "asset", causes: ["U"],
        }] }),
        makeReportCardsV9Card({ id: "rated" }),
      ]),
      makeReportCardsV9PipelineGapCard("control", "A", { id: "technical-gap" }),
    ];
    const ids = cards.map(card => card.id);
    const compiledFacts = compileNativeV3FactSet({
      ...coreFixture(), activeAssetIds: ids, assets: ids.map(id => minimalAsset(id)),
    });
    const policy = loadV9MethodologyPolicy(policyAsset);
    const completeness = {
      expectedCount: gapOnly ? 1 : 3, ratedCount: gapOnly ? 0 : 1, notRatedCount: gapOnly ? 0 : 1,
      notRatedIds: gapOnly ? [] : ["economic-nr"], pipelineGapCount: 1, pipelineGapIds: ["technical-gap"],
    };
    const registry = generateV9MissingDataRegistry({
      replay: { pipeline: { compiledFacts, candidate: {
        model: "v9-critical-path", schemaVersion: 8, openEvidence: EMPTY_OPEN_EVIDENCE, lifecycle: "active", candidateId: "safety-score-v9:fixture",
        policyVersion: policy.policy.releaseVersion, publicationGenerationId: "report-cards:v9:fixture",
        baseInputGenerationId: compiledFacts.baseInputGenerationId, factSetDigest: compiledFacts.v9FactSetDigest,
        resultDigest: "b".repeat(64), policy: { id: policy.policy.policyId, semanticDigest: policy.semanticDigest },
        evaluationBuildDigest: "c".repeat(64), sourceGenerations: { fixture: "fixture:g1" },
        asOfSec: compiledFacts.asOfSec, publishedAtSec: compiledFacts.asOfSec, completeness, foreignCauseGaps: [], cards,
      } } },
      policy: policyAsset,
      catalogEntries: ids.map(id => ({ id, file: `shared/data/stablecoins/coins/${id}.json`, coin: makeCoin(id) })),
    });
    expect(registry.summary).toMatchObject({
      stablecoinCount: completeness.expectedCount, rateableStablecoinCount: completeness.ratedCount,
      notRatedStablecoinCount: completeness.notRatedCount, pipelineGapStablecoinCount: completeness.pipelineGapCount,
      // Registry v2 publishes deterministic key/count rows, not the former keyed object.
      ratingStatusCounts: gapOnly ? [{ key: "pipeline-gap", count: 1 }]
        : [{ key: "not-rated", count: 1 }, { key: "pipeline-gap", count: 1 }, { key: "rated", count: 1 }],
    });
    expect(registry.summary.rateableStablecoinCount + registry.summary.notRatedStablecoinCount +
      registry.summary.pipelineGapStablecoinCount).toBe(registry.summary.stablecoinCount);
  });

  it("stores shared contexts once without changing compiled or supplemental task context", () => {
    const registry = generateExitProjectionFixture(["unsupported-same-notional-route", "unproven-settlement-bound"]);
    const stablecoin = registry.stablecoins[0]!;
    expect(registry.schemaVersion).toBe(2);
    expect(stablecoin.missingItems.map(item => item.taskSource))
      .toEqual(["compiled-fact-gap", "score-projection-gap"]);
    const refs = stablecoin.missingItems.map(item => item.currentFactContextRef);
    expect(new Set(refs).size).toBe(1);
    expect(Object.keys(stablecoin.currentFactContexts)).toEqual([refs[0]]);
    for (const item of stablecoin.missingItems) {
      expect(item).not.toHaveProperty("currentFactContext");
      expect(stablecoin.currentFactContexts[item.currentFactContextRef]).toMatchObject({
        exitStatus: { gapIds: ["exit-fixture:gap:exit-portfolio-coverage"] },
        routes: [],
      });
    }
  });

  it("keeps distinct path-scoped contexts within one work type, including explicit null", () => {
    const registry = generateExitProjectionFixture([], {
      contextKeys: ["exit-portfolio-coverage", "unrecognized-exit-component"],
    });
    const stablecoin = registry.stablecoins[0]!;
    expect(new Set(stablecoin.missingItems.map(item => item.workType)).size).toBe(1);
    expect(new Set(stablecoin.missingItems.map(item => item.currentFactContextRef)).size).toBe(2);
    expect(Object.values(stablecoin.currentFactContexts)).toContain(null);
    expect(Object.values(stablecoin.currentFactContexts)).toContainEqual(expect.objectContaining({ routes: [] }));
  });

  it("keeps serialized growth linear when many gaps share a growing whole-asset context", () => {
    const small = generateExitProjectionFixture([], { gapCount: 16 });
    const large = generateExitProjectionFixture([], { gapCount: 64 });
    const smallBytes = Buffer.byteLength(JSON.stringify(small));
    const largeBytes = Buffer.byteLength(JSON.stringify(large));
    expect(large.summary.openItemCount).toBe(4 * small.summary.openItemCount);
    expect(largeBytes).toBeLessThan(5 * smallBytes);
    expect(largeBytes).toBeLessThan(500_000);
    const stablecoin = large.stablecoins[0]!;
    expect(Object.keys(stablecoin.currentFactContexts)).toHaveLength(1);
    expect(new Set(stablecoin.missingItems.map(item => item.currentFactContextRef)).size).toBe(1);
  });

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

  it("fails closed when a score projection reason has no typed routing metadata", () => {
    expect(() => classifyV9ScoreProjectionWorkType("unregistered-projection-reason")).toThrow(
      /Missing agent work-type definition/,
    );
  });
});
