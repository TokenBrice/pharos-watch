import { makeAccessReview } from "@shared/lib/__tests__/safety-score-v9-access-lookthrough.test-support";
import { buildSafetyScoreV9AccessClaimGraph } from "../../src/lib/safety-score-v9/extension-access-lookthrough";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import { computeNativeDexLiquidityPayloadFingerprint, normalizeNativeV9Input, normalizeSafetyScoreV9CompilerInput } from "../../src/lib/safety-score-v9/native-input";
import { describe, expect, it, vi } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../../src/lib/safety-score-v9/extension";
import * as extensionBuilder from "../../src/lib/safety-score-v9/extension";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9/candidate";
import { createSafetyScoreV9LiveWithheldCompilation } from "../../src/lib/safety-score-v9/fact-set";
import * as evaluator from "@shared/lib/safety-score-v9/evaluate-set";
import { eligibleReserveMeta } from "../../src/lib/__tests__/safety-score-v9-reserve-admission.test-support";
import { makeV9TwoAssetFixedInput } from "../../src/test-helpers/v9-fixed-input";
import { buildCounterfactualPipeline, buildLiveWithheldCounterfactualReport, mergeLiveWithheldCounterfactualReports, readmitCounterfactualAccessGraph, renderLiveWithheldCounterfactualReport, type LiveWithheldShardResult } from "../check-safety-score-v9-live-withheld";

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
  it("publishes explicit partial coverage after an unrecoverable per-asset evaluation error", () => {
    const { replay, metaById } = healthyReplay([], true, true);
    const evaluate = evaluator.evaluateValidatedV9FactSet;
    const mock = vi.spyOn(evaluator, "evaluateValidatedV9FactSet").mockImplementation((facts, policy, interventions) => {
      const alpha = facts.assets.find(asset => asset.assetId === "alpha")!;
      if (!alpha.reserveExposures.some(exposure => exposure.provenance === "live")) {
        throw new evaluator.V9AssetEvaluationError("alpha", new Error("Fixture parent lacks wrapper-local facts"));
      }
      return evaluate(facts, policy, interventions);
    });
    try {
      const report = buildLiveWithheldCounterfactualReport(replay, metaById);
      expect(report.status).toBe("partial");
      expect(report.assessedCount).toBe(1);
      expect(report.failedAssets).toEqual([{
        assetId: "alpha", reasonCode: "counterfactual-evaluation-failed", errorClass: "V9AssetEvaluationError",
        message: "Safety Score v9 asset alpha evaluation failed: Fixture parent lacks wrapper-local facts",
      }]);
      const markdown = renderLiveWithheldCounterfactualReport(report);
      expect(markdown).toContain("Report status: **partial**");
      expect(markdown.indexOf("| alpha | counterfactual-evaluation-failed")).toBeLessThan(1600);
      const shards = [0, 1].map(index => ({
        shard: { index, count: 2, baseInputGenerationId: replay.pipeline.fixedInput.baseInputGenerationId,
          activeAssetIds: replay.pipeline.fixedInput.activeAssetIds },
        report: buildLiveWithheldCounterfactualReport(replay, metaById, { shard: { index, count: 2 } }),
      }));
      expect(mergeLiveWithheldCounterfactualReports(shards)).toEqual(report);
      mock.mockImplementation(() => { throw new evaluator.V9AssetEvaluationError("alpha", new Error("Every scenario fails")); });
      const failed = buildLiveWithheldCounterfactualReport(replay, metaById);
      expect(failed.status).toBe("partial");
      expect(failed.failedAssets).toHaveLength(2);
      expect(failed.assessedCount).toBe(0);
    } finally {
      mock.mockRestore();
    }
  });

  it("retains the pre-reuse default compiler digest", () => {
    const { pipeline } = healthyReplay([], true, true);
    // Recorded with the pre-change HEAD compiler; its complete JSON was also
    // compared byte-for-byte before replacing that temporary oracle with this pin.
    expect(pipeline.compiledFacts.v9FactSetDigest)
      .toBe("0b76a0c0be8ba41a1d1bc9a9de9b96fdf4e9c1f803c30152c2478ac04c23ce18");
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "reuses compiled siblings with byte-identical full pipelines (native=%s, graphs=%s)", (native, graphs) => {
      const { replay, metaById, fixedInput, pipeline } = healthyReplay([], graphs, native);
      const source = createSafetyScoreV9LiveWithheldCompilation(fixedInput, pipeline.extension);
      for (const assetId of fixedInput.activeAssetIds) {
        const draft = structuredClone(fixedInput);
        delete draft.liveReserveMap[assetId];
        delete draft.liveReserveProvenanceMap[assetId];
        draft.liveToFallbackCoins.push(assetId);
        const input = normalizeSafetyScoreV9CompilerInput({ ...draft, baseInputGenerationId: undefined });
        const full = buildCounterfactualPipeline(replay, input, assetId, metaById);
        const reused = buildCounterfactualPipeline(replay, input, assetId, metaById, source);
        expect(JSON.stringify(reused)).toBe(JSON.stringify(full));
      }
    },
  );

  it("preserves evaluation quarantine/recompilation rather than reusing a failed sibling", () => {
    const { replay, metaById, fixedInput, pipeline } = healthyReplay([], true, true);
    const source = createSafetyScoreV9LiveWithheldCompilation(fixedInput, pipeline.extension);
    const draft = structuredClone(fixedInput);
    delete draft.liveReserveMap.alpha;
    delete draft.liveReserveProvenanceMap.alpha;
    draft.liveToFallbackCoins.push("alpha");
    const input = normalizeSafetyScoreV9CompilerInput({ ...draft, baseInputGenerationId: undefined });
    const evaluate = evaluator.evaluateValidatedV9FactSet;
    const mock = vi.spyOn(evaluator, "evaluateValidatedV9FactSet");
    try {
      mock.mockImplementationOnce(() => { throw new evaluator.V9AssetEvaluationError("beta", new Error("Fixture evaluation defect")); })
        .mockImplementation(evaluate);
      const full = buildCounterfactualPipeline(replay, input, "alpha", metaById);
      mock.mockImplementationOnce(() => { throw new evaluator.V9AssetEvaluationError("beta", new Error("Fixture evaluation defect")); });
      const reused = buildCounterfactualPipeline(replay, input, "alpha", metaById, source);
      expect(reused.quarantines).toContainEqual(expect.objectContaining({ assetId: "beta", code: "evaluation-failed" }));
      expect(JSON.stringify(reused)).toBe(JSON.stringify(full));
    } finally {
      mock.mockRestore();
    }
  });

  it("rejects reuse when another producer or retained overlay changed", () => {
    const { fixedInput, pipeline } = healthyReplay([], true, true);
    const source = createSafetyScoreV9LiveWithheldCompilation(fixedInput, pipeline.extension);
    const input = normalizeSafetyScoreV9CompilerInput({
      ...fixedInput, baseInputGenerationId: undefined, liveReserveMap: {}, liveReserveProvenanceMap: {},
      liveToFallbackCoins: ["alpha", "beta"],
    });
    expect(() => source.compile(input, structuredClone(pipeline.extension), "alpha"))
      .toThrow("exactly one withheld reserve producer");
  });

  it("keeps upstream dependency propagation identical to full compilation", () => {
    const { fixedInput, metaById } = healthyReplay();
    metaById.set("alpha", fixtureMeta("alpha", {
      dependencies: [{ id: "beta", weight: 1, type: "wrapper" }],
      dependencyReview: {
        reviewedAt: "2026-10-07", reviewer: "Fixture reviewer", confidence: "verified",
        sources: [{ label: "Parent claim", url: "https://example.com/dependencies/parent" }],
        rationale: "The exact serial claim is reviewed.",
        relationships: [{ id: "beta", weight: 1, type: "wrapper", economicRole: "serial-claim",
          reason: "Reviewed parent claim." }],
      },
    }));
    const extension = buildSafetyScoreV9BaselineExtension(fixedInput, { allowRegistryMismatch: true, metaById });
    const pipeline = buildSafetyScoreV9Candidate({ fixedInput, extension, publishedAtSec: fixedInput.clockSec });
    const replay = JSON.parse(JSON.stringify({ pipeline }));
    const source = createSafetyScoreV9LiveWithheldCompilation(fixedInput, extension);
    const draft = structuredClone(fixedInput);
    delete draft.liveReserveMap.beta;
    delete draft.liveReserveProvenanceMap.beta;
    draft.liveToFallbackCoins.push("beta");
    const input = normalizeSafetyScoreV9CompilerInput({ ...draft, baseInputGenerationId: undefined });
    const full = buildCounterfactualPipeline(replay, input, "beta", metaById);
    const reused = buildCounterfactualPipeline(replay, input, "beta", metaById, source);
    expect(reused.compiledFacts.assets.find(asset => asset.assetId === "alpha")!.dependencies.edges)
      .toContainEqual(expect.objectContaining({ upstreamAssetId: "beta" }));
    expect(JSON.stringify(reused)).toBe(JSON.stringify(full));
  });

  it("merges deterministic shards into identical report bytes, including unknown and zero supplies", () => {
    const { replay, metaById } = healthyReplay([], true, true);
    replay.pipeline.evaluatedSet.assets[0]!.stressState!.exitPortfolio!.circulatingUsd = null;
    replay.pipeline.evaluatedSet.assets[1]!.stressState!.exitPortfolio!.circulatingUsd = 0;
    // Input order must not affect shard membership.
    replay.pipeline.fixedInput.activeAssetIds.reverse();
    const full = buildLiveWithheldCounterfactualReport(replay, metaById);
    const shards: LiveWithheldShardResult[] = [0, 1].map(index => ({
      shard: { index, count: 2, baseInputGenerationId: replay.pipeline.fixedInput.baseInputGenerationId,
        activeAssetIds: replay.pipeline.fixedInput.activeAssetIds },
      report: buildLiveWithheldCounterfactualReport(replay, metaById, { shard: { index, count: 2 } }),
    }));
    expect(mergeLiveWithheldCounterfactualReports([...shards].reverse())).toEqual(full);
    expect(renderLiveWithheldCounterfactualReport(mergeLiveWithheldCounterfactualReports(shards)))
      .toBe(renderLiveWithheldCounterfactualReport(full));
    expect(() => mergeLiveWithheldCounterfactualReports(shards.slice(0, 1))).toThrow("every shard");
    expect(() => mergeLiveWithheldCounterfactualReports([shards[0], shards[0]])).toThrow("overlap");
    const differentClock = structuredClone(shards);
    differentClock[1]!.report.clockSec++;
    expect(() => mergeLiveWithheldCounterfactualReports(differentClock)).toThrow("different replay");
  });

  it("builds only the target while preserving full-rebuild pipeline and report output", () => {
    const { replay, metaById, fixedInput } = healthyReplay([], true, true);
    const draft = structuredClone(fixedInput);
    delete draft.liveReserveMap.alpha;
    delete draft.liveReserveProvenanceMap.alpha;
    draft.liveToFallbackCoins.push("alpha");
    const counterfactual = normalizeSafetyScoreV9CompilerInput({ ...draft, baseInputGenerationId: undefined });
    const original = extensionBuilder.buildSafetyScoreV9BaselineExtensionFromNormalizedInput;
    const rebuild = vi.spyOn(extensionBuilder, "buildSafetyScoreV9BaselineExtensionFromNormalizedInput");
    try {
      const optimized = buildCounterfactualPipeline(replay, counterfactual, "alpha", metaById);
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect([...rebuild.mock.calls[0]![1]!.assetIds!]).toEqual(["alpha"]);
      expect(rebuild.mock.results[0]!.value.assets).toHaveLength(1);
      const report = buildLiveWithheldCounterfactualReport(replay, metaById);
      // Force the former full-cohort rebuild without duplicating the transform.
      rebuild.mockImplementation((input, options) => original(input, { ...options, assetIds: undefined }));
      expect(buildCounterfactualPipeline(replay, counterfactual, "alpha", metaById)).toEqual(optimized);
      expect(buildLiveWithheldCounterfactualReport(replay, metaById)).toEqual(report);
      expect(replay.pipeline.fixedInput.liveReserveMap.alpha).toBeDefined();
    } finally {
      rebuild.mockRestore();
    }
  });

  it("projects the exact full asset slice without losing cohort dependency cycles", () => {
    const { fixedInput, metaById } = healthyReplay([], true, true);
    const input = normalizeSafetyScoreV9CompilerInput({
      ...fixedInput, liveReserveMap: {}, liveReserveProvenanceMap: {}, baseInputGenerationId: undefined,
    });
    for (const [id, upstream] of [["alpha", "beta"], ["beta", "alpha"]]) {
      metaById.set(id!, fixtureMeta(id!, {
        dependencies: [{ id: upstream!, weight: 1, type: "wrapper" }],
        dependencyReview: {
          reviewedAt: "2026-10-07",
          reviewer: "Fixture reviewer",
          confidence: "verified",
          sources: [{ label: "Cycle review", url: "https://example.com/dependencies/cycle" }],
          rationale: "Mutual serial claims exercise full-cohort cycle diagnosis.",
          relationships: [{
            id: upstream!, weight: 1, type: "wrapper", economicRole: "serial-claim",
            reason: "Mutual serial claim for cycle handling.",
          }],
        },
      }));
    }
    const options = { metaById, allowRegistryMismatch: true };
    const full = extensionBuilder.buildSafetyScoreV9BaselineExtensionFromNormalizedInput(input, options);
    const selected = extensionBuilder.buildSafetyScoreV9BaselineExtensionFromNormalizedInput(input, {
      ...options, assetIds: new Set([input.activeAssetIds[0]!]),
    });
    expect(selected).toEqual({ ...full, assets: full.assets.filter((asset) => asset.assetId === "alpha") });
    expect(selected.assets[0]!.dependencies?.diagnostics).toMatchObject({
      graphState: "cycle", sccMemberAssetIds: ["alpha", "beta"],
    });
    expect(JSON.stringify(extensionBuilder.buildSafetyScoreV9BaselineExtensionFromNormalizedInput(input, options)))
      .toBe(JSON.stringify(full));
  });

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
