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
      { kind: "v9", expectedModel: "v9", snapshot: held },
      { nowSec: held.updatedAt },
    )).toMatchObject({
      state: "corrupt",
      failureReason: "v9-publication-held",
    });
    expect(assessActiveAlertSafetySource(
      { kind: "v9", expectedModel: "v9", snapshot: current },
      { nowSec: current.updatedAt + 6 * 60 * 60 + 1 },
    )).toMatchObject({
      state: "stale",
      failureReason: "v9-snapshot-stale",
    });
    expect(assessActiveAlertSafetySource(
      {
        kind: "error",
        expectedModel: "v9",
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
