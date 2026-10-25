import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSafetyScoreCohort } from "../safety-score-active-source";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "@shared/test-utils/mock-d1";

const { mockLoadActiveSafetyScoreCohort } = vi.hoisted(() => ({
  mockLoadActiveSafetyScoreCohort: vi.fn(),
}));

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreCohort: mockLoadActiveSafetyScoreCohort,
}));

import { checkSafetyScoreV9Publication } from "../canary-checks";

const NOW = 1_775_900_000;

function activeV9(): Extract<ActiveSafetyScoreCohort, { kind: "v9" }> {
  return {
    kind: "v9",
    projectionFallbackCount: 0,
    snapshot: makeReportCardsV9Response({ updatedAt: NOW - 60 }),
  };
}

describe("canonical V9 Safety Score consumers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1_000));
    mockLoadActiveSafetyScoreCohort.mockReset();
    mockLoadActiveSafetyScoreCohort.mockResolvedValue(activeV9());
  });

  afterEach(() => vi.useRealTimers());

  it.each([0, 1])("validates V9 identity and freshness with %i cohort fallbacks", async (projectionFallbackCount) => {
    mockLoadActiveSafetyScoreCohort.mockResolvedValue({ ...activeV9(), projectionFallbackCount });
    await expect(
      checkSafetyScoreV9Publication(mockD1()),
    ).resolves.toMatchObject({
      status: "ok",
      severity: "info",
      metadata: {
        updatedAt: NOW - 60,
        projectionFallbackCount,
      },
    });
  });

});
