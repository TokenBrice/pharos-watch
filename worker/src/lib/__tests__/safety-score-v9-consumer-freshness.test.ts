import { describe, expect, it } from "vitest";
import {
  isSafetyScoreV9SnapshotFresh,
  SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
} from "../safety-score-v9-consumer-freshness";
import { SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC } from "@shared/lib/cron-jobs";

describe("Safety Score V9 consumer freshness", () => {
  const currentHealth = {
    schemaVersion: 1 as const,
    status: "current" as const,
    acceptedPublicationGenerationId: "v9:test",
    acceptedAtSec: 1_800_000_000,
    attemptedAtSec: 1_800_000_000,
    heldSinceSec: null,
    reasons: [],
  };

  it("allows exactly one missed producer refresh", () => {
    expect(SAFETY_SCORE_V9_PUBLICATION_REFRESH_INTERVAL_SEC).toBe(30 * 60);
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
});
