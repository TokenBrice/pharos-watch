import { describe, expect, it } from "vitest";
import {
  isSafetyScoreV9SnapshotFresh,
  SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
} from "../safety-score-v9-consumer-freshness";
import { SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC } from "../safety-score-v9-shadow-runner";

describe("Safety Score V9 consumer freshness", () => {
  it("allows exactly one missed producer refresh", () => {
    expect(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC).toBe(
      2 * SAFETY_SCORE_V9_SHADOW_REFRESH_INTERVAL_SEC,
    );
  });

  it("accepts the age boundary and rejects an older snapshot", () => {
    const nowSec = 1_800_000_000;

    expect(
      isSafetyScoreV9SnapshotFresh(
        { updatedAt: nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC },
        nowSec,
      ),
    ).toBe(true);
    expect(
      isSafetyScoreV9SnapshotFresh(
        { updatedAt: nowSec - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1 },
        nowSec,
      ),
    ).toBe(false);
  });
});
