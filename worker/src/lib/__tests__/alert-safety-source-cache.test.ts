import { describe, expect, it } from "vitest";
import {
  alertSafetyIdentitiesAreComparable,
  assessActiveAlertSafetySource,
  buildActiveAlertSafetyV9SourceEnvelope,
  buildAlertSafetySnapshotEnvelope,
  getAlertSafetyV9SourceGeneration,
  parseAlertSafetySnapshotEnvelope,
} from "../alert-safety-source-cache";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";

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
