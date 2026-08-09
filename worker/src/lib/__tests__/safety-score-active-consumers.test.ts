import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSafetyScoreSource } from "../safety-score-active-source";
import { makeReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const mockLoadActiveSafetyScoreSource = vi.fn();

vi.mock("../safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: mockLoadActiveSafetyScoreSource,
}));

const { checkReportCardCacheMethodology } = await import("../canary-checks");
const { loadPublicationHealth } = await import("../publication-contract");

const NOW = 1_775_900_000;

function activeV9(): Extract<ActiveSafetyScoreSource, { kind: "v9" }> {
  return {
    kind: "v9",
    snapshot: makeReportCardsV9Response({ updatedAt: NOW - 60 }),
  };
}

describe("canonical V9 Safety Score consumers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1_000));
    mockLoadActiveSafetyScoreSource.mockReset();
    mockLoadActiveSafetyScoreSource.mockResolvedValue(activeV9());
  });

  afterEach(() => vi.useRealTimers());

  it("validates V9 identity and freshness in the canary", async () => {
    await expect(
      checkReportCardCacheMethodology(mockD1()),
    ).resolves.toMatchObject({
      status: "ok",
      severity: "info",
      metadata: {
        updatedAt: NOW - 60,
      },
    });
  });

  it("reports canonical cache ownership in publication health", async () => {
    const health = await loadPublicationHealth(mockD1(), NOW);

    expect(health.surfaces["safety-score-v9"]).toMatchObject({
      sourceOfTruth:
        "cache[report-cards:v9]+cache[report-cards:v9:publication-health]",
      lastPublishedGeneration: {
        state: "published",
      },
    });
  });
});
