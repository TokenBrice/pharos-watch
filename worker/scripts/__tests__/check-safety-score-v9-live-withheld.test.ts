import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { REPORT_CARD_GRADE_RANK } from "@shared/lib/report-card-core";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../../src/lib/safety-score-v9/extension";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9/candidate";
import { eligibleReserveMeta } from "../../src/lib/__tests__/safety-score-v9-reserve-admission.test-support";
import { makeV9TwoAssetFixedInput, v9TestClockSec } from "../../src/test-helpers/v9-fixed-input";
import { buildLiveWithheldCounterfactualReport, renderLiveWithheldCounterfactualReport } from "../check-safety-score-v9-live-withheld";

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

function healthyReplay(alreadyFallback: string[] = []) {
  const base = makeV9TwoAssetFixedInput({ clockSec: v9TestClockSec() });
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
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    allowRegistryMismatch: true,
    metaById,
  });
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput: fixed,
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
  };
}

describe("buildLiveWithheldCounterfactualReport", () => {
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
