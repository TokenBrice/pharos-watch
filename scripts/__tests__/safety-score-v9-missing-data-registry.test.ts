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
  documentationQuestionKeysByRoot,
  documentationResidualForRoot,
  documentationResidualQuestionKey,
  mechanismOverlayAdmissionWarnings,
  questionKeyForEntry,
  type DocumentationQuestionEntry,
} from "../maintenance/generate-safety-score-v9-missing-data-registry";
import type { V9EvidenceGapDocumentation } from "@shared/types/safety-score-v9-evidence-queue";
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
  options: { intern?: boolean; gapCount?: number; contextKeys?: readonly string[]; schemaVersion?: 7 | 8 } = {},
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
          schemaVersion: options.schemaVersion ?? 7,
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
          ...(options.schemaVersion === 8 ? {
            openEvidence: {
              semantics: "open-question-v1",
              totals: { questions: 0, open: 0, issuer: 0, documentation: 0, obligations: 0 },
              owners: [],
              reasons: [],
              documentation: { questions: 0, datums: 0, facts: 0, reasons: [] },
              issuer: { questions: 0, assets: 0, oldestReviewedAtSec: null, newestReviewedAtSec: null },
              byCard: [],
            },
          } : {}),
        },
        evaluatedSet: {
          assets: [{
            assetId,
            scoreInput: {
              pillars: { backing: { reasons: [] }, exit: { reasons: [] }, control: { reasons: [] } },
            },
            exit: { routes: [] },
          }],
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
        model: "v9-critical-path", schemaVersion: 7, lifecycle: "active", candidateId: "safety-score-v9:fixture",
        policyVersion: policy.policy.releaseVersion, publicationGenerationId: "report-cards:v9:fixture",
        baseInputGenerationId: compiledFacts.baseInputGenerationId, factSetDigest: compiledFacts.v9FactSetDigest,
        resultDigest: "b".repeat(64), policy: { id: policy.policy.policyId, semanticDigest: policy.semanticDigest },
        evaluationBuildDigest: "c".repeat(64), sourceGenerations: { fixture: "fixture:g1" },
        asOfSec: compiledFacts.asOfSec, publishedAtSec: compiledFacts.asOfSec, completeness, foreignCauseGaps: [], cards,
      },
        evaluatedSet: {
          assets: ids.map(id => ({
            assetId: id,
            scoreInput: { pillars: { backing: { reasons: [] }, exit: { reasons: [] }, control: { reasons: [] } } },
            exit: { routes: [] },
          })),
        },
      } },
      policy: policyAsset,
      catalogEntries: ids.map(id => ({ id, file: `shared/data/stablecoins/coins/${id}.json`, coin: makeCoin(id) })),
    });
    expect(registry.summary).toMatchObject({
      stablecoinCount: completeness.expectedCount, rateableStablecoinCount: completeness.ratedCount,
      notRatedStablecoinCount: completeness.notRatedCount, pipelineGapStablecoinCount: completeness.pipelineGapCount,
      // Registry v3 publishes deterministic key/count rows, not the former keyed object.
      ratingStatusCounts: gapOnly ? [{ key: "pipeline-gap", count: 1 }]
        : [{ key: "not-rated", count: 1 }, { key: "pipeline-gap", count: 1 }, { key: "rated", count: 1 }],
    });
    expect(registry.summary.rateableStablecoinCount + registry.summary.notRatedStablecoinCount +
      registry.summary.pipelineGapStablecoinCount).toBe(registry.summary.stablecoinCount);
  });

  it("stores shared contexts once without changing compiled or supplemental task context", () => {
    const registry = generateExitProjectionFixture(["unsupported-same-notional-route", "unproven-settlement-bound"]);
    const stablecoin = registry.stablecoins[0]!;
    expect(registry.schemaVersion).toBe(3);
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

const DOCUMENTATION: V9EvidenceGapDocumentation = {
  class: "documentation",
  reason: "no-scoring-path",
  policyRef: "semantic.evidence.documentation.reasons.no-scoring-path",
  threshold: null,
};
const RESERVE_DUST: V9EvidenceGapDocumentation = {
  class: "documentation",
  reason: "reserve-dust",
  policyRef: "semantic.evidence.documentation.reasons.reserve-dust",
  threshold: { kind: "reserve-book-share", value: 0.0001 },
};

type QuestionEntry = DocumentationQuestionEntry & { cause: "A" | "B" | "C" | "U" | "D" };

function controlQuestionEntry(args: {
  gapId: string;
  cause: QuestionEntry["cause"];
  factorKey: string;
  documentation: V9EvidenceGapDocumentation | null;
  assetId?: string;
}): QuestionEntry {
  return {
    assetId: args.assetId ?? "root",
    gapId: args.gapId,
    reasonCode: "missing-mint-authority",
    cause: args.cause,
    documentation: args.documentation,
    causeScope: {
      pillar: "control",
      componentKey: "control:issuer:demo",
      factorKey: args.factorKey,
      routeKey: null,
      exposureId: null,
      requiredDatum: "datum",
    },
  };
}

describe("Safety Score v9 documentation band", () => {
  it("keeps a mixed question out of the documentation band", () => {
    const documented = controlQuestionEntry({
      gapId: "root:gap:custody", cause: "U", factorKey: "keyCustody", documentation: DOCUMENTATION,
    });
    expect(questionKeyForEntry(documented)).toBe("root|control|control:issuer:demo");

    // One documentation obligation plus an issuer (C) obligation: the question
    // is issuer-owned, never documentation.
    const mixedIssuer = documentationQuestionKeysByRoot(
      [documented, controlQuestionEntry({
        gapId: "root:gap:mint", cause: "C", factorKey: "reconciliation", documentation: null,
      })],
      (entry) => entry.documentation,
    );
    expect(mixedIssuer.get("root")).toBeUndefined();

    // Same with an open (U) obligation.
    const mixedOpen = documentationQuestionKeysByRoot(
      [documented, controlQuestionEntry({
        gapId: "root:gap:mint", cause: "U", factorKey: "supervision", documentation: null,
      })],
      (entry) => entry.documentation,
    );
    expect(mixedOpen.get("root")).toBeUndefined();

    // Every obligation documentation-classed: exactly one question, however
    // many datums (and however many factor keys) answer it.
    const documentedOnly = documentationQuestionKeysByRoot(
      [
        documented,
        controlQuestionEntry({
          gapId: "root:gap:mint", cause: "U", factorKey: "reconciliation", documentation: DOCUMENTATION,
        }),
      ],
      (entry) => entry.documentation,
    );
    expect([...(documentedOnly.get("root") ?? [])]).toEqual(["root|control|control:issuer:demo"]);
  });

  it("drops measured-adverse rows from the question set", () => {
    const keys = documentationQuestionKeysByRoot(
      [controlQuestionEntry({ gapId: "root:gap:adverse", cause: "D", factorKey: "reconciliation", documentation: null })],
      (entry) => entry.documentation,
    );
    expect(keys.size).toBe(0);
  });

  it("collapses reserve dust into one residual question per root", () => {
    const dust = (gapId: string, exposureKey: string): QuestionEntry => ({
      assetId: "root",
      gapId,
      reasonCode: "material-reserve-slice-unstructured",
      cause: "U",
      documentation: RESERVE_DUST,
      causeScope: {
        pillar: "backing",
        componentKey: "reserve-exposure",
        factorKey: null,
        routeKey: null,
        exposureId: exposureKey,
        requiredDatum: "datum",
      },
    });
    const entries = [dust("root:gap:dust-a", "reserve:a"), dust("root:gap:dust-b", "reserve:b")];
    const residualKey = documentationResidualQuestionKey("root");
    expect(residualKey).toBe("root|reserve-exposure|reserve-residual:sub-0.01pct");
    for (const entry of entries) expect(questionKeyForEntry(entry)).toBe(residualKey);

    const documented = documentationQuestionKeysByRoot(entries, (entry) => entry.documentation);
    expect([...(documented.get("root") ?? [])]).toEqual([residualKey]);

    // Above the residual bar the merged question stays open even though every
    // datum under it is documentation-classed.
    const openResidual = documentationQuestionKeysByRoot(entries, (entry) => entry.documentation, [residualKey]);
    expect(openResidual.get("root")).toBeUndefined();
  });

  it("merges one residual per root and applies the 0.1% bar", () => {
    const dust = (gapId: string, exposureKey: string, weight: number) => ({
      gapId,
      path: { kind: "collateral-exposure" as const, exposureKey },
      materiality: { basis: "collateral-exposure" as const, fractionOfAsset: weight },
    });
    const taskIds = new Map([
      ["root:gap:dust-a", "V9G-aaaa"],
      ["root:gap:dust-b", "V9G-bbbb"],
    ]);

    const underBar = documentationResidualForRoot(
      "root",
      [dust("root:gap:dust-b", "reserve:b", 0.00005), dust("root:gap:dust-a", "reserve:a", 0.00005)],
      taskIds,
      0.1,
    );
    expect(underBar).toMatchObject({
      questionKey: "root|reserve-exposure|reserve-residual:sub-0.01pct",
      rootAssetId: "root",
      reason: "reserve-dust",
      bucket: "documentation",
      thresholdBookSharePct: 0.1,
      exposureKeys: ["reserve:a", "reserve:b"],
      datumGapIds: ["root:gap:dust-a", "root:gap:dust-b"],
      datumTaskIds: ["V9G-aaaa", "V9G-bbbb"],
      datumCount: 2,
    });
    expect(underBar.bookSharePct).toBeCloseTo(0.01, 12);

    const rows = Array.from({ length: 11 }, (_, index) =>
      dust(`root:gap:dust-${index}`, `reserve:${index}`, 0.0000999));
    const overBar = documentationResidualForRoot("root", rows, taskIds, 0.1);
    expect(overBar.bucket).toBe("open");
    expect(overBar.datumCount).toBe(11);
  });

  it("reads both the schema-7 cutover envelope and the schema-8 publication", () => {
    const previous = generateExitProjectionFixture(["unsupported-same-notional-route"]);
    const current = generateExitProjectionFixture(["unsupported-same-notional-route"], { schemaVersion: 8 });
    expect(current.schemaVersion).toBe(3);
    expect(current.stablecoins[0]!.missingItems.map((item) => item.taskId))
      .toEqual(previous.stablecoins[0]!.missingItems.map((item) => item.taskId));
    expect(current.summary.openItemCount).toBe(previous.summary.openItemCount);
  });

  it("publishes the v3 documentation shape on a replay with no documentation datum", () => {
    const registry = generateExitProjectionFixture(["unsupported-same-notional-route"]);
    const stablecoin = registry.stablecoins[0]!;
    expect(stablecoin.documentationResiduals).toEqual([]);
    expect(stablecoin.missingDataSummary).toMatchObject({
      documentationItemCount: 0,
      documentationDatumCount: 0,
      documentationQuestionCount: 0,
      researchedTerminalItemCount: 0,
    });
    for (const item of stablecoin.missingItems) {
      expect(item.documentation).toBeNull();
      expect(item.reviewState).toBeNull();
      // A zero-route inventory keeps the coverage label open (never documentation);
      // a gap without a cause scope keeps the gapless `path|<code>` identity.
      expect(item.questionKey).toBe("exit-fixture|path|incomplete-dex-route-coverage");
    }
    expect(registry.summary).toMatchObject({
      documentationItemCount: 0,
      documentationDatumCount: 0,
      documentationQuestionCount: 0,
      documentationResidualCount: 0,
      documentationResidualDatumCount: 0,
      documentationOpenResidualCount: 0,
      researchedTerminalItemCount: 0,
    });
    expect(registry.summary.documentationReasonCounts.map((row) => row.reason)).toEqual([
      "no-scoring-path",
      "unknown-scores-as-no-credit",
      "unscored-diagnostic",
      "coverage-label",
      "immaterial-deployment",
      "reserve-dust",
    ]);
    expect(registry.interpretation.documentationBand).toContain("--include-documentation");
  });
});
