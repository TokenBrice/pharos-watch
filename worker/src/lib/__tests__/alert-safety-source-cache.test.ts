import { afterEach, describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../safety-score-v9/consumer-freshness";
import {
  alertSafetyIdentitiesAreComparable,
  assessAlertSafetyEnvelope,
  buildAlertSafetyV9SourceEnvelopeFromParts,
  buildAlertSafetySnapshotEnvelope,
  ALERT_SAFETY_V9_SOURCE_GENERATION,
  loadActiveAlertSafetySourceAssessment,
  parseAlertSafetySnapshotEnvelope,
  parsePersistedAlertSafetyV9SourceEnvelope,
} from "../alert-safety-source-cache";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function persistedDb(response: ReportCardsV9CurrentResponse | null) {
  const { sqlite, db } = fixtures.open();
  if (response) {
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run("alert-safety-v9-source", JSON.stringify(buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
    })), response.updatedAt);
    insert.run("report-cards:v9:publication-health", stableJsonStringifyV1(response.publicationHealth), response.publicationHealth.attemptedAtSec);
  }
  return db;
}

describe("canonical V9 alert safety source", () => {
  it("projects the accepted publication with native V9 explanations", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });

    expect(buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })).toMatchObject({
      generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
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

  it("fails closed for held, stale, and unavailable publications", async () => {
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

    expect(await loadActiveAlertSafetySourceAssessment(persistedDb(held), held.updatedAt)).toMatchObject({
      state: "corrupt",
      failureReason: "v9-publication-held",
      sourcePublicationGenerationId: current.safetyScoreIdentity.publicationGenerationId,
      acceptedPublicationGenerationId: current.publicationHealth.acceptedPublicationGenerationId,
      generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
      ageSeconds: 0,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      assessedAtSec: held.updatedAt,
      heldSinceSec: current.updatedAt + 60,
      holdReasonCodes: ["dex-stale"],
    });
    expect(await loadActiveAlertSafetySourceAssessment(
      persistedDb(current), current.updatedAt + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC + 1,
    )).toMatchObject({
      state: "stale",
      failureReason: "v9-snapshot-stale",
    });
    expect(await loadActiveAlertSafetySourceAssessment(persistedDb(null), current.updatedAt)).toMatchObject({
      state: "missing",
      failureReason: "v9-snapshot-unavailable",
    });
  });

  it("round-trips the V9 dispatch baseline and compares only like identities", () => {
    const response = makeWorkerReportCardsV9Response();
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt });
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
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
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
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
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
  it("round-trips a persisted source envelope through the strict parser", () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt });
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

  it("retains the old parser's projection bytes while stripping unknown envelope, row and explanation keys", () => {
    const response = makeWorkerReportCardsV9Response({ cards: [makeWorkerV9Card({ grade: "A+", score: 91 })] });
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
    });
    const row = source.snapshot["usdc-circle"];
    const decorated = { ...source, ignored: true, snapshot: { "usdc-circle": {
      ...row, id: "ignored", ignored: true, v9Explain: {
        ...row.v9Explain, ignored: true,
        reasons: row.v9Explain.reasons.map((reason) => ({ ...reason, ignored: true })),
        pillars: { ...row.v9Explain.pillars, ignored: true,
          backing: { ...row.v9Explain.pillars.backing, ignored: true } },
      },
    } } };
    const cached = { value: JSON.stringify(decorated), updatedAt: response.updatedAt };
    const baseline = buildAlertSafetySnapshotEnvelope(source.snapshot, source.generation, source.safetyScoreIdentity);
    expect(JSON.stringify(parsePersistedAlertSafetyV9SourceEnvelope(cached))).toBe(JSON.stringify({
      ...source, safetyScoreIdentity: baseline.safetyScoreIdentity,
    }));
    expect(JSON.stringify(parseAlertSafetySnapshotEnvelope(cached))).toBe(JSON.stringify(baseline));
  });

  it.each([
    ["v9Explain", undefined], ["v9Explain", null], ["v9Explain.reasons", {}],
    ["v9Explain.reasons", [{ code: 1, message: "bad" }]],
    ["v9Explain.bindingCap", { kind: "cap", limit: "1", reason: "" }],
    ["v9Explain.weakestPillar", { pillar: "exit", score: null }],
    ["v9Explain.pillars.exit", undefined], ["v9Explain.pillars.exit.score", "0"],
    ["v9Explain.pillars.control.evidenceLevel", false], ["operationallyAffected", null],
    ["methodologyVersion", undefined], ["partialEvidence", undefined],
  ])("preserves old-parser rejection for malformed nested %s=%j", (path, value) => {
    const response = makeWorkerReportCardsV9Response();
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
    });
    const raw: Record<string, unknown> = JSON.parse(JSON.stringify(source.snapshot["usdc-circle"]));
    const keys = (path as string).split(".");
    let target = raw;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys[keys.length - 1]] = value;
    const cached = { value: JSON.stringify({ ...source, snapshot: { "usdc-circle": raw } }), updatedAt: 0 };
    expect(parsePersistedAlertSafetyV9SourceEnvelope(cached)).toBeNull();
    expect(parseAlertSafetySnapshotEnvelope(cached)).toBeNull();
  });

  it("preserves nullable/optional fields and the distinct source-versus-baseline model rule", () => {
    const response = makeWorkerReportCardsV9Response();
    const source = buildAlertSafetyV9SourceEnvelopeFromParts({
      cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt,
    });
    const row = source.snapshot["usdc-circle"];
    const snapshot = { "usdc-circle": { ...row, methodologyVersion: null, operationallyAffected: false,
      v9Explain: { reasons: [], bindingCap: null, weakestPillar: null, pillars: {
        backing: { score: null, evidenceLevel: "", freshness: "" },
        exit: { score: -1, evidenceLevel: "", freshness: "" },
        control: { score: 0, evidenceLevel: "", freshness: "" },
      } } } };
    const parse = (value: unknown) => ({ value: JSON.stringify(value), updatedAt: 0 });
    expect(parsePersistedAlertSafetyV9SourceEnvelope(parse({ ...source, snapshot }))?.snapshot).toEqual(snapshot);
    const identity = source.safetyScoreIdentity;
    const v8 = { model: "v8", schemaVersion: 1, methodologyVersion: identity.methodologyVersion,
      evaluationBuildDigest: identity.evaluationBuildDigest, baseInputGenerationId: identity.baseInputGenerationId,
      publicationGenerationId: identity.publicationGenerationId };
    const historic = parse({ ...source, safetyScoreIdentity: v8 });
    expect(parseAlertSafetySnapshotEnvelope(historic)?.safetyScoreIdentity.model).toBe("v8");
    expect(parsePersistedAlertSafetyV9SourceEnvelope(historic)).toBeNull();
    expect(parseAlertSafetySnapshotEnvelope(parse({ ...source, safetyScoreIdentity: undefined }))).toBeNull();
    expect(parsePersistedAlertSafetyV9SourceEnvelope({
      value: JSON.stringify(source).replace(/"score":[0-9.]+/, '"score":1e400'), updatedAt: 0,
    })).toBeNull();
  });

  it("resolves envelope-first assessments from health alone, without the publication decode", async () => {
    const response = makeWorkerReportCardsV9Response({
      updatedAt: 1_700_000_000,
      cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A+", score: 91 })],
    });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;

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
      ageSeconds: 60,
      generation: envelope.generation,
      sourcePublicationGenerationId: envelope.publicationGenerationId,
      acceptedPublicationGenerationId: envelope.publicationGenerationId,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      assessedAtSec: response.updatedAt + 60,
      holdReasonCodes: [
        "dex-stale",
        "dex-unavailable",
        "redemption-stale",
        "redemption-unavailable",
        "live-reserves-unavailable",
      ],
    });
  });

  it.each(["legacy", "missing", "malformed", "mismatched"] as const)("fails closed for a %s persisted thin projection", async (kind) => {
    const response = makeWorkerReportCardsV9Response();
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
    const value = kind === "legacy" ? JSON.stringify({ ...envelope, generation: "safety-v9-alert-source-v1" })
      : kind === "malformed" ? "{"
      : JSON.stringify({ ...envelope, publicationGenerationId: "different-generation" });
    const db = persistedDb(response);
    if (kind === "missing") {
      await db.prepare("DELETE FROM cache WHERE key = ?").bind("alert-safety-v9-source").run();
    } else {
      await db.prepare("UPDATE cache SET value = ? WHERE key = ?").bind(value, "alert-safety-v9-source").run();
    }
    expect(await loadActiveAlertSafetySourceAssessment(db, response.updatedAt)).toMatchObject({
      state: kind === "missing" ? "missing" : "corrupt", envelope: null,
      failureReason: kind === "legacy" ? "publication-schema-cutover-pending"
        : kind === "missing" ? "v9-snapshot-unavailable" : "v9-snapshot-invalid",
    });
    const assessment = await loadActiveAlertSafetySourceAssessment(db, response.updatedAt + 60);
    expect(assessment).toMatchObject({
      sourcePublicationGenerationId: kind === "mismatched" ? "different-generation" : null,
      acceptedPublicationGenerationId: envelope.publicationGenerationId,
      ageSeconds: kind === "mismatched" ? 60 : null,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      assessedAtSec: response.updatedAt + 60,
    });
  });

  it.each(["health-read", "source-read", "both-read", "health-invalid", "source-invalid"] as const)("retains successful sibling provenance for %s", async (failure) => {
    const response = makeWorkerReportCardsV9Response({ updatedAt: 1_700_000_000 });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
    const db = makeNoopD1({ prepare: () => ({ bind: (key: string) => ({ first: async () => {
      if (key === "report-cards:v9:publication-health") {
        if (failure === "health-read" || failure === "both-read") throw new Error("health read failed");
        return { value: failure === "health-invalid" ? "{" : stableJsonStringifyV1(response.publicationHealth), updated_at: response.publicationHealth.attemptedAtSec };
      }
      if (key === "alert-safety-v9-source") {
        if (failure === "source-read" || failure === "both-read") throw new Error("source read failed");
        // Cache-write recency must never replace the publication timestamp.
        return { value: failure === "source-invalid" ? "{" : JSON.stringify(envelope), updated_at: response.updatedAt + 299 };
      }
      throw new Error("Full publication must not be read");
    } }) }) });
    expect(await loadActiveAlertSafetySourceAssessment(db, response.updatedAt + 300)).toMatchObject({
      state: "corrupt", envelope: null,
      failureReason: failure.endsWith("invalid") ? "v9-snapshot-invalid" : "v9-snapshot-read-failed",
      acceptedPublicationGenerationId: failure === "health-read" || failure === "health-invalid" || failure === "both-read" ? null : envelope.publicationGenerationId,
      sourcePublicationGenerationId: failure === "source-read" || failure === "source-invalid" || failure === "both-read" ? null : envelope.publicationGenerationId,
      ageSeconds: failure === "source-read" || failure === "source-invalid" || failure === "both-read" ? null : 300,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      assessedAtSec: response.updatedAt + 300,
    });
  });

  it("admits the exact consumer budget boundary and rejects the next second", () => {
    const response = makeWorkerReportCardsV9Response();
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
    const boundary = envelope.publishedAt + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC;
    expect(assessAlertSafetyEnvelope(envelope, boundary)).toMatchObject({
      state: "ok", ageSeconds: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      sourcePublicationGenerationId: envelope.publicationGenerationId,
      acceptedPublicationGenerationId: envelope.publicationGenerationId,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec: boundary,
    });
    expect(assessAlertSafetyEnvelope(envelope, boundary + 1)).toMatchObject({ state: "stale", failureReason: "v9-snapshot-stale" });
  });

  it("fails closed on a future-dated accepted clock instead of clamping it to age zero", async () => {
    const response = makeWorkerReportCardsV9Response({ updatedAt: 1_700_000_000 });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;
    expect(assessAlertSafetyEnvelope(envelope, envelope.publishedAt)).toMatchObject({ state: "ok", ageSeconds: 0 });
    expect(assessAlertSafetyEnvelope(envelope, envelope.publishedAt - 1)).toMatchObject({
      state: "corrupt", failureReason: "v9-snapshot-future", ageSeconds: null, envelope: null,
      sourcePublicationGenerationId: envelope.publicationGenerationId,
    });
    expect(assessAlertSafetyEnvelope({ ...envelope, publishedAt: Number.NaN }, envelope.publishedAt)).toMatchObject({
      state: "corrupt", failureReason: "v9-snapshot-invalid", ageSeconds: null,
    });
    expect(await loadActiveAlertSafetySourceAssessment(persistedDb(response), 1_699_999_000)).toMatchObject({
      state: "corrupt", failureReason: "v9-snapshot-future", ageSeconds: null,
    });
  });

  it("assesses a persisted envelope with the same staleness rules as the live source", async () => {
    const response = makeWorkerReportCardsV9Response({ updatedAt: 1_700_000_000 });
    const envelope = buildAlertSafetyV9SourceEnvelopeFromParts({ cards: response.cards, safetyScoreIdentity: response.safetyScoreIdentity, publishedAt: response.updatedAt })!;

    expect(await loadActiveAlertSafetySourceAssessment(persistedDb(response), 1_700_000_060)).toMatchObject({
      state: "ok",
      ageSeconds: 60,
      envelope,
    });
    expect(
      await loadActiveAlertSafetySourceAssessment(persistedDb(response), 1_700_000_000 + 100_000_000),
    ).toMatchObject({ state: "stale", failureReason: "v9-snapshot-stale" });
  });
});
