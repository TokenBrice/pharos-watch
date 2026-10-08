import { makeAccessReview } from "@shared/lib/__tests__/safety-score-v9-access-lookthrough.test-support";
import { buildSafetyScoreV9AccessClaimGraph } from "../../src/lib/safety-score-v9/extension-access-lookthrough";
import { ReviewEvidenceBuilder } from "../../src/lib/safety-score-v9/extension-shared";
import { computeNativeDexLiquidityPayloadFingerprint, normalizeNativeV9Input, normalizeSafetyScoreV9CompilerInput } from "../../src/lib/safety-score-v9/native-input";
import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../../src/lib/safety-score-v9/extension";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9/candidate";
import { eligibleReserveMeta } from "../../src/lib/__tests__/safety-score-v9-reserve-admission.test-support";
import { makeV9TwoAssetFixedInput } from "../../src/test-helpers/v9-fixed-input";
import { buildCounterfactualPipeline, buildLiveWithheldCounterfactualReport, readmitCounterfactualAccessGraph, renderLiveWithheldCounterfactualReport } from "../check-safety-score-v9-live-withheld";

function fixtureMeta(id: string, overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return eligibleReserveMeta({
    id,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    liveReservesConfig: {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    },
    ...overrides,
  });
}

function healthyReplay(alreadyFallback: string[] = [], withGraphs = false, native = false) {
  const base = makeV9TwoAssetFixedInput({ clockSec: Date.parse("2026-10-08T06:00:00Z") / 1_000 });
  const fixed = structuredClone(base);
  fixed.liveToFallbackCoins = alreadyFallback;
  fixed.liveReserveMap.beta = structuredClone(fixed.liveReserveMap.alpha);
  fixed.liveReserveProvenanceMap.beta = {
    source: "fixture-reserve-api",
    fetchedAt: fixed.clockSec - 100,
  };
  fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
  const metaById = new Map<string, V9ExtensionRegistryMeta>([
    [
      "alpha",
      fixtureMeta("alpha", {
        mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
        proofOfReserves: undefined,
        reserveReview: { ...eligibleReserveMeta().reserveReview!, knownUnknownExposurePct: 1 },
      }),
    ],
    ["beta", fixtureMeta("beta")],
  ]);
  const dexLiqMap = Object.fromEntries(Object.entries(fixed.dexLiqMap).map(([id, row]) => [id, { updatedAt: row.updatedAt }]));
  const {
    bluechipMap: _bluechipMap, resolvedBlacklistStatuses: _resolvedBlacklistStatuses,
    collateralDriftCoins: _collateralDriftCoins, ...nativeDraft
  } = fixed;
  const nativeInput = native ? normalizeNativeV9Input({
    ...nativeDraft,
    schemaVersion: 4,
    captureKind: "native-v9-inputs",
    baseInputGenerationId: undefined,
    dexLiqMap,
    dexPayloadFingerprint: computeNativeDexLiquidityPayloadFingerprint(dexLiqMap, fixed.dexGenerationId),
    chainCirculatingById: Object.fromEntries(Object.entries(fixed.chainCirculatingById).map(([id, chains]) => [
      id, Object.fromEntries(Object.entries(chains).map(([chain, bucket]) => [chain, { current: bucket.current }])),
    ])),
  }) : fixed;
  const extension = buildSafetyScoreV9BaselineExtension(nativeInput, {
    allowRegistryMismatch: true,
    metaById,
    ...(withGraphs ? { accessClaimGraphReviews: new Map(["alpha", "beta"].map((id) => {
      const review = makeAccessReview(id, new Date((fixed.clockSec - 100) * 1_000).toISOString());
      for (const edge of review.edges) if (edge.basis.kind === "reserve-position") edge.basis = { kind: "selected-observation" };
      return [id, review];
    })) } : {}),
  });
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput: nativeInput,
    extension,
    publishedAtSec: fixed.clockSec,
  });
  return {
    // The CLI reads a replay artifact off disk, so round-trip through JSON:
    // that is the shape under test and it drops the pipeline's readonly arrays.
    replay: JSON.parse(JSON.stringify({ pipeline })) as Parameters<
      typeof buildLiveWithheldCounterfactualReport
    >[0],
    metaById,
    pipeline,
    fixedInput: nativeInput,
  };
}

describe("buildLiveWithheldCounterfactualReport", () => {
  it("re-admits retained reviewed graphs identically to a fresh build at the frozen clock", () => {
    const clockSec = Date.parse("2026-10-08T06:00:00Z") / 1_000;
    const review = makeAccessReview("alpha", new Date((clockSec - 100) * 1_000).toISOString());
    const sourceInput = { clockSec, baseInputGenerationId: "fixture:source" };
    const nextInput = { clockSec, baseInputGenerationId: "fixture:counterfactual" };
    const original = buildSafetyScoreV9AccessClaimGraph({
      assetId: "alpha", clockSec, generationId: sourceInput.baseInputGenerationId,
      evidence: new ReviewEvidenceBuilder("alpha", clockSec), review,
    });
    const fresh = buildSafetyScoreV9AccessClaimGraph({
      assetId: "alpha", clockSec, generationId: nextInput.baseInputGenerationId,
      evidence: new ReviewEvidenceBuilder("alpha", clockSec), review,
    });
    expect(readmitCounterfactualAccessGraph(original, sourceInput, nextInput)).toEqual(fresh);
    expect(() => readmitCounterfactualAccessGraph(
      original, sourceInput, { ...nextInput, clockSec: clockSec + 1 },
    )).toThrow("Access graph must match the admitted clock and input generation");
    expect(() => readmitCounterfactualAccessGraph(
      { ...original, nodes: [] }, sourceInput, nextInput,
    )).toThrow();
  });
  it.each([false, true])("replays every access graph at the full frozen counterfactual generation (native=%s)", (native) => {
    const { replay, metaById, pipeline } = healthyReplay([], true, native);
    const graphs = pipeline.compiledFacts.assets.map((asset) => asset.accessReview.freeze.claimGraph);
    expect(graphs).toHaveLength(2);
    for (const graph of graphs) {
      expect(graph).toMatchObject({
        clockSec: replay.pipeline.fixedInput.clockSec,
        generationId: replay.pipeline.fixedInput.baseInputGenerationId,
      });
    }
    expect(pipeline.candidate.completeness.pipelineGapCount).toBe(0);
    const report = buildLiveWithheldCounterfactualReport(replay, metaById);
    expect(report.clockSec).toBe(replay.pipeline.fixedInput.clockSec);
    expect(report.assessedCount).toBe(2);
    expect(report.excludedCounts["fallback-pipeline-gap"]).toBe(0);
  });
  it.each([false, true])("preserves capture-time overlays with and without graphs (graphs=%s)", (withGraphs) => {
    const { replay, metaById, pipeline: capturedPipeline, fixedInput } = healthyReplay([], withGraphs, true);
    const draft = structuredClone(fixedInput);
    delete draft.liveReserveMap.alpha;
    delete draft.liveReserveProvenanceMap.alpha;
    draft.liveToFallbackCoins.push("alpha");
    const counterfactual = normalizeSafetyScoreV9CompilerInput({ ...draft, baseInputGenerationId: undefined });
    // Today's metadata is deliberately different from the captured beta review.
    // An indiscriminate full rebuild must not replace the offline overlay.
    metaById.set("beta", fixtureMeta("beta", { launchDate: "2025-01-01" }));
    const pipeline = buildCounterfactualPipeline(replay, counterfactual, "alpha", metaById);
    expect(pipeline.quarantines).toEqual([]);
    const beta = pipeline.compiledFacts.assets.find((asset) => asset.assetId === "beta")!;
    const capturedBeta = capturedPipeline.compiledFacts.assets.find((asset) => asset.assetId === "beta")!;
    expect(beta.implementation).toEqual(capturedBeta.implementation);
    if (withGraphs) {
      for (const asset of pipeline.compiledFacts.assets) {
        const captured = capturedPipeline.compiledFacts.assets.find((row) => row.assetId === asset.assetId)!;
        expect(asset.accessReview.freeze.claimGraph).toEqual({
          ...captured.accessReview.freeze.claimGraph,
          generationId: counterfactual.baseInputGenerationId,
        });
      }
    }
  });
  it("reports worse fallback ratings while omitting assets already using fallback evidence", () => {
    const { replay, metaById } = healthyReplay(["beta"]);
    const alpha = replay.pipeline.evaluatedSet.assets.find((asset) => asset.assetId === "alpha");
    if (!alpha?.stressState?.exitPortfolio) throw new Error("Fixture has no alpha exit portfolio");
    alpha.stressState.exitPortfolio.circulatingUsd = null;

    const report = buildLiveWithheldCounterfactualReport(replay, metaById);
    const { rows } = report;

    expect(rows).toEqual([
      expect.objectContaining({
        assetId: "alpha",
        supplyUsd: null,
        supplyAvailability: "unavailable",
        supplyUnavailableReason: "null-supply",
        fallbackTier: "none",
        fallbackEvidenceCeiling: null,
        fallbackBindingCapKind: null,
      }),
    ]);
    expect(REPORT_CARD_GRADE_RANK[rows[0]!.fallbackGrade]).toBeLessThan(REPORT_CARD_GRADE_RANK[rows[0]!.liveGrade]);
    expect(rows.some((row) => row.assetId === "beta")).toBe(false);
    expect(report.excludedCounts["already-fallback"]).toBe(1);
    expect(renderLiveWithheldCounterfactualReport(report)).toContain("unknown (null-supply)");
  });

  it("does not classify a pipeline-gap observation as a grade downgrade", () => {
    const { replay, metaById } = healthyReplay(["beta"]);
    const gap = makeReportCardsV9PipelineGapCard(null, "A", { id: "alpha" });
    replay.pipeline.candidate.cards = replay.pipeline.candidate.cards.map((card) =>
      card.id === "alpha" ? gap : card,
    );

    const report = buildLiveWithheldCounterfactualReport(replay, metaById);
    expect(report.rows).toEqual([]);
    expect(report.excludedCounts["baseline-pipeline-gap"]).toBe(1);
    expect(renderLiveWithheldCounterfactualReport(report)).toContain("No assessed eligible strict grade downgrades");
  });

  it.each([0, undefined])("preserves observed zero versus missing supply (%s)", (supply) => {
    const { replay, metaById } = healthyReplay(["beta"]);
    const alpha = replay.pipeline.evaluatedSet.assets.find(asset => asset.assetId === "alpha")!;
    alpha.stressState!.exitPortfolio!.circulatingUsd = supply;
    const report = buildLiveWithheldCounterfactualReport(replay, metaById);
    expect(report.rows[0]).toMatchObject(supply === 0
      ? { supplyUsd: 0, supplyAvailability: "observed", supplyUnavailableReason: null }
      : { supplyUsd: null, supplyAvailability: "unavailable", supplyUnavailableReason: "missing-supply" });
    const rendered = renderLiveWithheldCounterfactualReport(report);
    expect(rendered).toContain(supply === 0 ? "| 0 |" : "unknown (missing-supply)");
  });
});
