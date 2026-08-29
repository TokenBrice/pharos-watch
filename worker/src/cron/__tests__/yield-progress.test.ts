import { describe, expect, it, vi } from "vitest";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import { createYieldProgressReporter } from "../yield-progress";

describe("createYieldProgressReporter", () => {
  it("reports the default Yield progress envelope", async () => {
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });
    const { progressTotal, reportYieldProgress } = createYieldProgressReporter(reportProgress, {
      yieldBearingCoins: 3,
      opportunityCoins: 2,
    });

    await reportYieldProgress("source-resolution", "Resolving yield source candidates", "yield", {
      itemsDone: 1,
    });

    expect(progressTotal).toBe(5);
    expect(progressUpdates).toEqual([
      {
        stage: "source-resolution",
        message: "Resolving yield source candidates",
        itemsDone: 1,
        itemsTotal: 5,
        metadata: {
          providerFamily: "yield",
          phase: "source-resolution",
          countTotals: {
            yieldBearingCoins: 3,
            opportunityCoins: 2,
            totalTrackedForYield: 5,
          },
        },
      },
    ]);
  });

  it("preserves caller metadata and custom item totals", async () => {
    const reportProgress = vi.fn(async (_update: CronProgressUpdate) => {});
    const { reportYieldProgress } = createYieldProgressReporter(reportProgress, {
      yieldBearingCoins: 3,
      opportunityCoins: 2,
    });

    await reportYieldProgress("state-loaded", "Loaded yield source state", "yield-source-cache", {
      itemsDone: 7,
      itemsTotal: 11,
      metadata: {
        supplementalMode: "cache",
        countTotals: {
          dlPools: 4,
          supplementalCandidates: 2,
        },
      },
    });

    expect(reportProgress).toHaveBeenCalledWith({
      stage: "state-loaded",
      message: "Loaded yield source state",
      itemsDone: 7,
      itemsTotal: 11,
      metadata: {
        providerFamily: "yield-source-cache",
        phase: "state-loaded",
        supplementalMode: "cache",
        countTotals: {
          dlPools: 4,
          supplementalCandidates: 2,
        },
      },
    });
  });
});
