import { describe, expect, it } from "vitest";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import {
  buildFlightToQualityClassificationFromV9Snapshot,
} from "../flight-to-quality-classification";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, isSafetyScoreV9SnapshotFresh } from "../safety-score-v9/consumer-freshness";
import { ReportCardsV9CurrentResponseSchema } from "\@shared/types/report-cards-v9-current";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";
import { getPublicSafetyScoreStatus } from "@shared/lib/public-health";

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
    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected canonical V9 classification");
    const { classification } = result;
    expect(classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(classification.riskyIds).toEqual(new Set(["usdt-tether"]));
    expect(result.classification.safetyScoreIdentity.model).toBe("v9");
  });

  it("includes rated partial cards but excludes pipeline gaps from both cohorts", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000),
      cards: [
        makeReportCardsV9PipelineGapCard(null, "B", { id: "dai-makerdao" }),
        makeReportCardsV9PartialCard("exit", "B", { id: "usdc-circle" }),
        makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" }),
      ],
    });
    ReportCardsV9CurrentResponseSchema.parse(snapshot);
    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected available partial publication");
    expect(result.classification.safeIds).toEqual(new Set(["usdc-circle"]));
    expect(result.classification.riskyIds).toEqual(new Set());
  });


  it("rejects a non-active lifecycle before using its cohorts", () => {
    const snapshot = makeWorkerReportCardsV9Response({ updatedAt: Math.floor(Date.now() / 1000) });
    expect(buildFlightToQualityClassificationFromV9Snapshot(snapshot).kind).toBe("ok");
    // The current contract narrows lifecycle to "active"; a shadow publication can
    // only reach this consumer as untrusted upstream data.
    const shadowSnapshot = { ...snapshot, lifecycle: "shadow" } as unknown as typeof snapshot;
    expect(buildFlightToQualityClassificationFromV9Snapshot(
      shadowSnapshot,
    )).toEqual({ kind: "unavailable", reason: "lifecycle-not-approved" });
  });

  it("requires a complete current V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      cards: [makeWorkerV9Card()],
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const result = buildFlightToQualityClassificationFromV9Snapshot(snapshot);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected canonical V9 classification");
    expect(result.classification.safeIds).toEqual(new Set(["usdc-circle"]));

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      { ...snapshot, completeness: { ...snapshot.completeness, expectedCount: 2 } },
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
    )).toEqual({ kind: "unavailable", reason: "publication-held" });
  });

  it("fails closed for a stale current V9 snapshot", () => {
    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: Math.floor(Date.now() / 1000) - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1,
    });

    expect(buildFlightToQualityClassificationFromV9Snapshot(
      snapshot,
    )).toEqual({ kind: "unavailable", reason: "source-stale" });
  });
});

describe("Safety Score V9 consumer freshness", () => {
  const currentHealth = {
    schemaVersion: 2 as const,
    status: "current" as const,
    acceptedPublicationGenerationId: "v9:test",
    acceptedAtSec: 1_800_000_000,
    attemptedAtSec: 1_800_000_000,
    heldSinceSec: null,
    reasons: [],
  };

  it("allows exactly one missed producer refresh", () => {
    expect(SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC).toBe(60 * 60);
    expect(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC).toBe(
      2 * SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC,
    );
  });

  it("accepts the age boundary and rejects an older snapshot", () => {
    const nowSec = 1_800_000_000;

    expect(
      isSafetyScoreV9SnapshotFresh(
        {
          updatedAt: nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
          publicationHealth: currentHealth,
        },
        nowSec,
      ),
    ).toBe(true);
    expect(
      isSafetyScoreV9SnapshotFresh(
        {
          updatedAt: nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1,
          publicationHealth: currentHealth,
        },
        nowSec,
      ),
    ).toBe(false);
  });

  it("rejects a nonfinite publication time under current health", () => {
    const nowSec = 1_800_000_000;
    expect(isSafetyScoreV9SnapshotFresh({
      updatedAt: Number.POSITIVE_INFINITY,
      publicationHealth: currentHealth,
    }, nowSec)).toBe(false);
    expect(isSafetyScoreV9SnapshotFresh({
      updatedAt: Number.NEGATIVE_INFINITY,
      publicationHealth: currentHealth,
    }, nowSec)).toBe(false);
    expect(isSafetyScoreV9SnapshotFresh({
      updatedAt: nowSec,
      publicationHealth: currentHealth,
    }, Number.NaN)).toBe(false);
  });

  it("accepts the present instant but rejects any future publication time", () => {
    const nowSec = 1_800_000_000;

    expect(
      isSafetyScoreV9SnapshotFresh({ updatedAt: nowSec, publicationHealth: currentHealth }, nowSec),
    ).toBe(true);
    expect(
      isSafetyScoreV9SnapshotFresh(
        { updatedAt: nowSec + 1, publicationHealth: currentHealth },
        nowSec,
      ),
    ).toBe(false);
  });

  it("treats a held snapshot as unavailable even when its accepted time is fresh", () => {
    const nowSec = 1_800_000_000;
    expect(
      isSafetyScoreV9SnapshotFresh(
        {
          updatedAt: nowSec,
          publicationHealth: {
            ...currentHealth,
            status: "held",
            heldSinceSec: nowSec,
            reasons: [{ code: "dex-stale" }],
          },
        },
        nowSec,
      ),
    ).toBe(false);
  });

  it("keeps the intentional held divergence: current-only rejects, public health tolerates", () => {
    const nowSec = 1_800_000_000;
    const held = {
      ...currentHealth, status: "held" as const, acceptedAtSec: nowSec - 60,
      attemptedAtSec: nowSec, heldSinceSec: nowSec - 30, reasons: [{ code: "dex-stale" as const }],
    };
    expect(isSafetyScoreV9SnapshotFresh({ updatedAt: nowSec - 60, publicationHealth: held }, nowSec)).toBe(false);
    expect(getPublicSafetyScoreStatus(held, nowSec)).toBe("healthy");
  });
});
