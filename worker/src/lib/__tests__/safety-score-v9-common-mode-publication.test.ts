import { describe, expect, it, vi } from "vitest";
import capture from "./fixtures/safety-score-v9-usdt-premium-capture.json";
import { createReportCardsFixedInput, type ReportCardsFixedInputDraft } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { projectSafetyScoreV9PublicationToPublicSnapshot } from "../report-cards-v9-cache";
import { ReportCardsV9CurrentResponseSchema } from "\@shared/types/report-cards-v9-current";
import { SafetyScoreV9CommonModeGroupsSchema } from "@shared/types/safety-score-v9-public";
import { projectSafetyScoreV9CommonModeGroups } from "@shared/lib/safety-score-v9/public";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { resolveV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { capturedAccessMetaById } from "./safety-score-v9-capture.test-support";

function replay() {
  const fixedInput = createReportCardsFixedInput(capture.draft as unknown as ReportCardsFixedInputDraft);
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput, publishedAtSec: capture.publishedAtSec,
    // Common-mode publication uses the captured blacklist evidence, not optional
    // transfer overlays researched after this historical capture's clock.
    registry: { metaById: capturedAccessMetaById, reviewedTransferFacts: new Map() },
  });
  const publication = pipeline.candidate;
  const report = projectSafetyScoreV9PublicationToPublicSnapshot(publication, {
    schemaVersion: 2, status: "current", acceptedPublicationGenerationId: publication.publicationGenerationId,
    acceptedAtSec: publication.publishedAtSec, attemptedAtSec: publication.publishedAtSec, heldSinceSec: null, reasons: [],
  });
  return { pipeline, report };
}

describe("V9 common-mode publication", () => {
  it("does not warn or mark ordinary diagnostic and pillar-only signals as incomplete", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { report } = replay();
      expect(report.commonModeGroups!.filter((group) => group.pricedEffectsIncomplete)).toEqual([]);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("publishes the evaluator's group membership and retains the already-priced effects", () => {
    const { pipeline, report } = replay();
    expect(report.commonModeGroups?.map(({ id, memberAssetIds }) => ({ id, memberAssetIds }))).toEqual(
      pipeline.evaluatedSet.dependencyPlan.commonModeGroups.map((group) => ({
        id: `${group.failureDomain.kind}:${group.failureDomain.key}`,
        memberAssetIds: [...new Set(group.members.map((member) => member.assetId))].sort(),
      })).filter((group) => group.memberAssetIds.length >= 2),
    );
    for (const group of report.commonModeGroups!) {
      const expectedPricedAssetIds = group.memberAssetIds.filter((assetId) => {
        const trace = pipeline.evaluatedSet.assets.find((asset) => asset.assetId === assetId)!.trace;
        return trace.deploymentAdjustments.some((adjustment) => adjustment.failureDomainKey === group.id);
      });
      expect((group.pricedEffects ?? []).map((effect) => effect.assetId)).toEqual(expectedPricedAssetIds);
      for (const effect of group.pricedEffects ?? []) {
        const card = resolveV9PublicWitnessTexts(report.cards.find((asset) => asset.id === effect.assetId)!);
        expect(effect.capIndices).toEqual([]);
        expect(effect.deploymentAdjustmentIndices.length).toBeGreaterThan(0);
        for (const index of effect.deploymentAdjustmentIndices) {
          expect(card.scoreTrace.deploymentRisk.adjustments[index].failureDomainKey).toBe(group.id);
        }
      }
    }
  });

  it("preserves exact priced-effect references across interned and resolved public cards", () => {
    const { pipeline, report } = replay();
    const results = pipeline.evaluatedSet.assets.map((asset) => ({ ...asset, policy: V9_CANDIDATE_POLICY_V1 }));
    const expected = projectSafetyScoreV9CommonModeGroups(
      pipeline.evaluatedSet.dependencyPlan.commonModeGroups, results,
      report.cards,
    );
    expect(projectSafetyScoreV9CommonModeGroups(
      pipeline.evaluatedSet.dependencyPlan.commonModeGroups, results, pipeline.candidate.cards,
    )).toEqual(expected);
    expect(report.commonModeGroups).toEqual(expected);
  });


  it("parses the real candidate to public mapper path with typed wrapper provenance", () => {
    const { pipeline, report } = replay();
    const serial = report.dependencyGraph.edges.find((edge) => edge.to === "susdt-spark" && edge.kind === "serial")!;
    expect(serial).toMatchObject({ dependencyType: "wrapper", wrapperForm: "native-staked", provenance: expect.any(Object) });
    expect(ReportCardsV9CurrentResponseSchema.parse(report).cards).toEqual(pipeline.candidate.cards.map((card) => resolveV9PublicWitnessTexts(card)));
    const changed = structuredClone(report);
    changed.dependencyGraph.edges[0].to = "wrong-dependent";
    expect(ReportCardsV9CurrentResponseSchema.safeParse(changed).success).toBe(false);
    // Basket edges depend on current reserve curation admitted at the capture
    // clock, so the edge count varies; a repeated edge always breaks ordering.
    const unsorted = structuredClone(report);
    unsorted.dependencyGraph.edges.push(structuredClone(unsorted.dependencyGraph.edges[0]));
    expect(ReportCardsV9CurrentResponseSchema.safeParse(unsorted).success).toBe(false);
  });

  it("rejects retired report families instead of interpreting absent census fields as current", () => {
    const { report } = replay();
    const legacy = { ...report };
    delete legacy.commonModeGroups;
    expect(ReportCardsV9CurrentResponseSchema.safeParse({ ...legacy, schemaVersion: 5 }).success).toBe(false);
    expect(ReportCardsV9CurrentResponseSchema.safeParse({ ...report, schemaVersion: 6 }).success).toBe(false);
    expect(ReportCardsV9CurrentResponseSchema.safeParse({ ...report, schemaVersion: 7 }).success).toBe(false);
    expect(ReportCardsV9CurrentResponseSchema.safeParse(report).success).toBe(true);
  });

  it("does not publish multiple paths on one asset as a shared failure domain", () => {
    expect(projectSafetyScoreV9CommonModeGroups([{
      failureDomain: { kind: "reserve-custodian", key: "bank" },
      members: [
        { assetId: "alpha", owner: "backing", pathKey: "cash" },
        { assetId: "alpha", owner: "backing", pathKey: "bonds" },
      ],
    }], [], [])).toEqual([]);
  });

  it("rejects duplicate and out-of-order domain, membership and effect references", () => {
    const group = {
      id: "reserve-custodian:bank", kind: "reserve-custodian", key: "bank", memberAssetIds: ["alpha", "beta"],
      pricedEffects: [{ assetId: "alpha", capIndices: [0, 1], deploymentAdjustmentIndices: [] }],
    };
    expect(SafetyScoreV9CommonModeGroupsSchema.parse([group])).toEqual([group]);
    for (const invalid of [
      [group, group],
      [{ ...group, id: "reserve-custodian:z", key: "z" }, group],
      [{ ...group, memberAssetIds: ["beta", "alpha"] }],
      [{ ...group, memberAssetIds: ["alpha", "alpha"] }],
      [{ ...group, memberAssetIds: ["alpha"] }],
      [{ ...group, pricedEffects: [group.pricedEffects[0], group.pricedEffects[0]] }],
      [{ ...group, pricedEffects: [{ ...group.pricedEffects[0], capIndices: [1, 0] }] }],
      [{ ...group, pricedEffects: [{ ...group.pricedEffects[0], capIndices: [0, 0] }] }],
      [{ ...group, pricedEffects: [{ ...group.pricedEffects[0], capIndices: [] }] }],
    ]) {
      expect(SafetyScoreV9CommonModeGroupsSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
