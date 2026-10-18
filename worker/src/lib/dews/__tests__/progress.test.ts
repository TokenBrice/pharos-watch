import { describe, expect, it, vi } from "vitest";
import type { CronProgressReporter, CronResult } from "../../cron-logger";
import type { StablecoinsDependencyDiagnostics } from "../contracts";
import { buildStablecoinsCacheFailureResult, reportDewsProgress } from "../progress";

describe("reportDewsProgress", () => {
  it("does nothing when no progress reporter is configured", async () => {
    await expect(reportDewsProgress(undefined, "scoring", { validationFailures: 0 })).resolves.toBeUndefined();
  });

  it("forwards the stage, DEWS-prefixed message, and metadata exactly once", async () => {
    const reporter = vi.fn<CronProgressReporter>(async () => {});
    const metadata = { rowsComputed: 12, rowsWritten: 10, sourceFailures: 2, validationFailures: 1 };

    await reportDewsProgress(reporter, "persistence", metadata);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({ stage: "persistence", message: "DEWS persistence", metadata });
  });

  it("propagates a reporter failure instead of hiding it", async () => {
    const failure = new Error("progress write failed");
    const reporter = async () => {
      throw failure;
    };

    await expect(reportDewsProgress(reporter, "scoring", { validationFailures: 0 })).rejects.toBe(failure);
  });
});

describe("buildStablecoinsCacheFailureResult", () => {
  const stablecoins: StablecoinsDependencyDiagnostics = {
    generationId: "stablecoins-cache:1791991846",
    updatedAt: 1_791_991_846,
    ageSeconds: 1539,
    freshnessBudgetSec: 1380,
    reason: "stale-generation",
  };

  function parseMetadata(result: CronResult): Record<string, unknown> {
    return JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
  }

  it("withholds publication and names the unavailable stablecoins cohort", () => {
    const result = buildStablecoinsCacheFailureResult("cohort-age-1539s-exceeds-1380s", stablecoins);

    expect(result.itemCount).toBe(0);
    expect(result.status).toBe("degraded");
    expect(result.productivity).toEqual({
      productive: false,
      reason: "dews-generation-withheld-degraded",
      publications: [],
    });
    expect(parseMetadata(result)).toEqual({
      rowsRead: 0,
      rowsWritten: 0,
      rowsDropped: 0,
      reason: "dews-cohort-dependency-unavailable",
      dependencies: { stablecoins },
      degradedSources: ["stablecoins-cache"],
      publicationPointerWritten: false,
      freshnessSentinelPublished: false,
      sourceCoverage: { stablecoins: 0 },
      sourceFailures: [{ source: "stablecoins-cache", reason: "cohort-age-1539s-exceeds-1380s" }],
      fallbackMode: "stablecoins-cache-unavailable",
      validationFailures: 1,
    });
  });

  it("records the caller's dependency read instead of inventing a fresh cohort", () => {
    const readFailed: StablecoinsDependencyDiagnostics = {
      generationId: null,
      updatedAt: null,
      ageSeconds: null,
      freshnessBudgetSec: 1380,
      reason: "read-failed",
    };

    const metadata = parseMetadata(buildStablecoinsCacheFailureResult("read-failed", readFailed));

    expect(metadata.dependencies).toEqual({ stablecoins: readFailed });
    expect(metadata.sourceFailures).toEqual([{ source: "stablecoins-cache", reason: "read-failed" }]);
  });
});
