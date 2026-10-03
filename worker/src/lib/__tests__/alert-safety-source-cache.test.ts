import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import {
  alertSafetyIdentitiesAreComparable,
  assessActiveAlertSafetySource,
  buildActiveAlertSafetyV9SourceEnvelope,
  buildAlertSafetySnapshotEnvelope,
  getAlertSafetyV9SourceGeneration,
  loadActiveAlertSafetySourceAssessment,
  parseAlertSafetySnapshotEnvelope,
} from "../alert-safety-source-cache";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

describe("canonical V9 alert safety source", () => {
  it("projects the accepted publication with native V9 explanations", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });

    expect(buildActiveAlertSafetyV9SourceEnvelope(response)).toMatchObject({
      generation: getAlertSafetyV9SourceGeneration(),
      safetyScoreIdentity: response.safetyScoreIdentity,
      publishedAt: response.updatedAt,
      snapshot: {
        "usdc-circle": {
          grade: "A+",
          score: 91,
          v9Explain: {
            pillars: {
              backing: { evidenceLevel: "adequate" },
              exit: { evidenceLevel: "adequate" },
              control: { evidenceLevel: "adequate" },
            },
          },
        },
      },
    });
  });

  it("fails closed for held, stale, and unavailable publications", () => {
    const current = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
    });
    const held = makeWorkerReportCardsV9Response({
      ...current,
      publicationHealth: {
        ...current.publicationHealth,
        status: "held",
        attemptedAtSec: current.updatedAt + 60,
        heldSinceSec: current.updatedAt + 60,
        reasons: [{ code: "dex-stale" }],
      },
    });

    expect(assessActiveAlertSafetySource(
      {
        kind: "held",
        reason: "v9-publication-held",
        detail: "Canonical Safety Score V9 ratings are held at the last verified snapshot",
        snapshot: held,
      },
      { nowSec: held.updatedAt },
    )).toMatchObject({
      state: "corrupt",
      failureReason: "v9-publication-held",
      heldSinceSec: current.updatedAt + 60,
      holdReasonCodes: ["dex-stale"],
    });
    expect(assessActiveAlertSafetySource(
      { kind: "v9", snapshot: current },
      { nowSec: current.updatedAt + 6 * 60 * 60 + 1 },
    )).toMatchObject({
      state: "stale",
      failureReason: "v9-snapshot-stale",
    });
    expect(assessActiveAlertSafetySource(
      {
        kind: "error",
        reason: "v9-snapshot-unavailable",
        snapshot: null,
        detail: "missing",
      },
      { nowSec: current.updatedAt },
    )).toMatchObject({
      state: "missing",
      failureReason: "v9-snapshot-unavailable",
    });
  });

  it("round-trips the V9 dispatch baseline and compares only like identities", () => {
    const response = makeWorkerReportCardsV9Response();
    const source = buildActiveAlertSafetyV9SourceEnvelope(response);
    expect(source).not.toBeNull();
    const envelope = buildAlertSafetySnapshotEnvelope(
      source!.snapshot,
      source!.generation,
      source!.safetyScoreIdentity,
    );
    const parsed = parseAlertSafetySnapshotEnvelope({
      value: JSON.stringify(envelope),
      updatedAt: response.updatedAt,
    });

    expect(parsed).toEqual(envelope);
    expect(alertSafetyIdentitiesAreComparable(
      response.safetyScoreIdentity,
      response.safetyScoreIdentity,
    )).toBe(true);
    expect(alertSafetyIdentitiesAreComparable(
      response.safetyScoreIdentity,
      {
        ...response.safetyScoreIdentity,
        evaluationBuildDigest: "f".repeat(64),
      },
    )).toBe(false);
  });

  it.each(["partial", "single-pillar", "all-pillars"] as const)("preserves %s availability and compact causes in the dispatch baseline", (kind) => {
    const card = kind === "partial" ? makeReportCardsV9PartialCard("exit", "B")
      : makeReportCardsV9PipelineGapCard(kind === "single-pillar" ? "control" : null);
    const response = makeWorkerReportCardsV9Response({ cards: [card] });
    const source = buildActiveAlertSafetyV9SourceEnvelope(response)!;
    const envelope = buildAlertSafetySnapshotEnvelope(source.snapshot, source.generation, source.safetyScoreIdentity);
    const parsed = parseAlertSafetySnapshotEnvelope({ value: JSON.stringify(envelope), updatedAt: response.updatedAt });
    expect(parsed?.snapshot[card.id]).toMatchObject({
      grade: card.grade, score: card.score, ratingStatus: card.ratingStatus,
      partialEvidence: {
        reasonCode: "partial-evidence-pipeline-gap",
        excludedPillars: card.partialEvidence!.excludedPillars,
        causes: card.partialEvidence!.causes,
      },
    });
    expect(parsed?.snapshot[card.id].partialEvidence).not.toHaveProperty("causeGapIds");
    expect(parsed?.snapshot[card.id].partialEvidence).not.toHaveProperty("excludedComponentKeys");
  });

  it("rejects old-generation and falsely graded pipeline-gap baselines", () => {
    const response = makeWorkerReportCardsV9Response({ cards: [makeReportCardsV9PipelineGapCard()] });
    const source = buildActiveAlertSafetyV9SourceEnvelope(response)!;
    const parse = (value: unknown) => parseAlertSafetySnapshotEnvelope({ value: JSON.stringify(value), updatedAt: response.updatedAt });
    expect(parse({ ...source, generation: "safety-v9-alert-source-v1" })).toBeNull();
    const row = source.snapshot["usdc-circle"];
    for (const grade of ["NR", "F"]) {
      expect(parse({ ...source, snapshot: { "usdc-circle": { ...row, grade } } })).toBeNull();
    }
    expect(parse({ ...source, snapshot: { "usdc-circle": { ...row, score: 0 } } })).toBeNull();
  });
});

describe("persisted V9 alert source envelope", () => {
  it("round-trips a persisted source envelope through the strict parser", async () => {
    const { buildActiveAlertSafetyV9SourceEnvelope, parsePersistedAlertSafetyV9SourceEnvelope } =
      await import("../alert-safety-source-cache");
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });
    const envelope = buildActiveAlertSafetyV9SourceEnvelope(response);
    expect(envelope).not.toBeNull();

    const parsed = parsePersistedAlertSafetyV9SourceEnvelope({
      value: JSON.stringify(envelope),
      updatedAt: 1_700_000_100,
    });

    expect(parsed).toEqual(envelope);
    expect(parsePersistedAlertSafetyV9SourceEnvelope(null)).toBeNull();
    expect(
      parsePersistedAlertSafetyV9SourceEnvelope({ value: "{\"generation\":42}", updatedAt: 0 }),
    ).toBeNull();
  });

  it("resolves envelope-first assessments from health alone, without the publication decode", async () => {
    const { buildActiveAlertSafetyV9SourceEnvelope, loadActiveAlertSafetySourceAssessment } =
      await import("../alert-safety-source-cache");
    const { stableJsonStringifyV1 } = await import("@shared/lib/stable-json");
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });
    const envelope = buildActiveAlertSafetyV9SourceEnvelope(response)!;

    const makeDb = (healthStatus: "current" | "held"): D1Database => {
      const health = {
        schemaVersion: 2 as const,
        status: healthStatus,
        acceptedPublicationGenerationId: envelope.publicationGenerationId,
        acceptedAtSec: response.updatedAt,
        attemptedAtSec: response.updatedAt,
        heldSinceSec: healthStatus === "held" ? response.updatedAt : null,
        reasons:
          healthStatus === "held"
            ? [
                { code: "dex-stale" as const },
                { code: "dex-unavailable" as const },
                { code: "redemption-stale" as const },
                { code: "redemption-unavailable" as const },
                { code: "live-reserves-unavailable" as const },
                { code: "coverage-floor-failed" as const, floorIds: ["minimum-rateable-assets"] },
              ]
            : [],
      };
      const rows = new Map<string, { value: string; updated_at: number }>([
        [
          "report-cards:v9:publication-health",
          { value: stableJsonStringifyV1(health), updated_at: health.attemptedAtSec },
        ],
        ["alert-safety-v9-source", { value: JSON.stringify(envelope), updated_at: response.updatedAt }],
      ]);
      return makeNoopD1({
        prepare: (sql: string) => ({
          bind: (key: string) => ({
            first: async () => {
              if (key === "report-cards:v9") {
                throw new Error("publication decode must not run on the envelope-first path");
              }
              if (!sql.includes("FROM cache")) throw new Error(`unexpected sql: ${sql}`);
              return rows.get(key) ?? null;
            },
          }),
        }),
      });
    };

    await expect(
      loadActiveAlertSafetySourceAssessment(makeDb("current"), response.updatedAt + 60),
    ).resolves.toMatchObject({ state: "ok", ageSeconds: 60 });

    await expect(
      loadActiveAlertSafetySourceAssessment(makeDb("held"), response.updatedAt + 60),
    ).resolves.toMatchObject({
      state: "corrupt",
      envelope: null,
      failureReason: "v9-publication-held",
      heldSinceSec: response.updatedAt,
      holdReasonCodes: [
        "dex-stale",
        "dex-unavailable",
        "redemption-stale",
        "redemption-unavailable",
        "live-reserves-unavailable",
      ],
    });
  });

  it.each(["legacy", "missing", "malformed", "mismatched"] as const)("fails closed for a %s thin projection without a full publication read", async (kind) => {
    const response = makeWorkerReportCardsV9Response();
    const envelope = buildActiveAlertSafetyV9SourceEnvelope(response)!;
    const value = kind === "legacy" ? JSON.stringify({ ...envelope, generation: "safety-v9-alert-source-v1" })
      : kind === "malformed" ? "{"
      : JSON.stringify({ ...envelope, publicationGenerationId: "different-generation" });
    const readKeys: string[] = [];
    const db = makeNoopD1({ prepare: () => ({ bind: (key: string) => ({ first: async () => {
      readKeys.push(key);
      if (key === "report-cards:v9:publication-health") return { value: stableJsonStringifyV1(response.publicationHealth), updated_at: response.publicationHealth.attemptedAtSec };
      if (key === "alert-safety-v9-source") return kind === "missing" ? null : { value, updated_at: response.updatedAt };
      throw new Error("Full publication reads exceed the alert lane's heap budget");
    } }) }) });
    expect(await loadActiveAlertSafetySourceAssessment(db, response.updatedAt)).toMatchObject({
      state: kind === "missing" ? "missing" : "corrupt", envelope: null,
      failureReason: kind === "legacy" ? "publication-schema-cutover-pending"
        : kind === "missing" ? "v9-snapshot-unavailable" : "v9-snapshot-invalid",
    });
    expect(readKeys).not.toContain("report-cards:v9");
  });

  it("assesses a persisted envelope with the same staleness rules as the live source", async () => {
    const { assessAlertSafetyEnvelope, buildActiveAlertSafetyV9SourceEnvelope } =
      await import("../alert-safety-source-cache");
    const response = makeWorkerReportCardsV9Response({ updatedAt: 1_700_000_000 });
    const envelope = buildActiveAlertSafetyV9SourceEnvelope(response)!;

    expect(assessAlertSafetyEnvelope(envelope, 1_700_000_060)).toMatchObject({
      state: "ok",
      ageSeconds: 60,
      envelope,
    });
    expect(
      assessAlertSafetyEnvelope(envelope, 1_700_000_000 + 100_000_000),
    ).toMatchObject({ state: "stale", failureReason: "v9-snapshot-stale" });
  });
});
