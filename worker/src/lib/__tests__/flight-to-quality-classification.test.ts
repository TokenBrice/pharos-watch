import { describe, expect, it } from "vitest";
import {
  buildFlightToQualityClassificationFromV9Snapshot,
} from "../flight-to-quality-classification";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../safety-score-v9/consumer-freshness";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9";

describe("buildFlightToQualityClassificationFromV9Snapshot", () => {
  it("uses canonical V9 grade boundaries for safe classifications", () => {
    const risky = makeWorkerV9Card({ id: "usdt-tether", score: 40, grade: "D", qualityScore: 40 });
    risky.scoreTrace.adverseAttribution.items.push({
      source: "pillar-score", path: "pillar:backing:score", message: "Measured weak backing",
      responsibility: "measured-adverse",
    });
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [
        makeWorkerV9Card({ id: "dai-makerdao", score: 50, grade: "C-" }),
        makeWorkerV9Card({ id: "untracked-token", score: 90, grade: "A+" }),
        makeWorkerV9Card({ id: "usdc-circle", score: 65, grade: "B-" }),
        risky,
      ],
    });
    ReportCardsV9CurrentResponseSchema.parse(snapshot);
    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot, {});

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected canonical V9 classification");
    const { classification } = result;
    expect(classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(classification.riskyIds).toEqual(new Set(["usdt-tether"]));
    expect(result.classification.safetyScoreIdentity.model).toBe("v9");
  });

  it.each([
    { publicationGenerationId: "report-cards:v9:other" },
    { policyDigest: "d".repeat(64) },
    { baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}` },
  ])("fails closed for an independently mismatched identity %j", (mismatch) => {
    const snapshot = makeWorkerReportCardsV9Response({ updatedAt: Math.floor(Date.now() / 1000) });
    expect(buildFlightToQualityClassificationFromV9Snapshot(snapshot, {
      expectedIdentity: {
        ...snapshot.safetyScoreIdentity,
        ...mismatch,
      },
    })).toEqual({
      kind: "unavailable",
      reason: "identity-mismatch",
    });
  });

  it("rejects a non-active lifecycle before using its cohorts", () => {
    const snapshot = makeWorkerReportCardsV9Response({ updatedAt: Math.floor(Date.now() / 1000) });
    expect(buildFlightToQualityClassificationFromV9Snapshot(snapshot, {}).kind).toBe("ok");
    // The current contract narrows lifecycle to "active"; a shadow publication can
    // only reach this consumer as untrusted upstream data.
    const shadowSnapshot = { ...snapshot, lifecycle: "shadow" } as unknown as typeof snapshot;
    expect(buildFlightToQualityClassificationFromV9Snapshot(
      shadowSnapshot, {},
    )).toEqual({ kind: "unavailable", reason: "lifecycle-not-approved" });
  });

  it("requires a complete current V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      cards: [makeWorkerV9Card()],
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot, {});
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected canonical V9 classification");
    expect(result.classification.safeIds).toEqual(new Set(["usdc-circle"]));

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      { ...snapshot, completeness: { ...snapshot.completeness, expectedCount: 2 } },
      {},
    )).toEqual({ kind: "unavailable", reason: "source-contract-invalid" });

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      {
        ...snapshot,
        publicationHealth: {
          ...snapshot.publicationHealth,
          status: "held",
          attemptedAtSec: snapshot.updatedAt + 1_800,
          heldSinceSec: snapshot.updatedAt + 1_800,
          reasons: [{ code: "dex-stale" }],
        },
      },
      {},
    )).toEqual({ kind: "unavailable", reason: "publication-held" });
  });

  it("fails closed for a stale current V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000) - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1,
    });

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      snapshot,
      {},
    )).toEqual({ kind: "unavailable", reason: "source-stale" });
  });
});
