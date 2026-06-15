import { describe, expect, it } from "vitest";
import type { CronRun, CronStatus, StatusResponse } from "@shared/types";
import { getCronSeverity, sortCronGroupsBySeverity } from "@/app/admin/cron-severity";
import type { CronGroup } from "@/app/admin/sections/cron-lane-types";
import { countConsecutiveStatus, getLastSuccessfulRun } from "@/app/admin/sections/cron-lane-table";
import { deriveInitialPipelineTab } from "@/app/admin/sections/pipeline-section";

function makeCron(overrides: Partial<CronStatus>): CronStatus {
  return {
    lastRun: null,
    recentRuns: [],
    expectedIntervalSec: 300,
    healthy: true,
    ...overrides,
  };
}

function run(status: CronRun["status"]): CronRun {
  return { startedAt: 1_000, durationMs: 10, status };
}

describe("getCronSeverity", () => {
  it("returns 1 for telemetry-unknown bootstrap (highest precedence)", () => {
    // telemetryUnknown wins even when the cron also looks unhealthy
    expect(
      getCronSeverity(makeCron({ telemetryUnknown: true, healthy: false, lastRun: run("error") })),
    ).toBe(1);
  });

  it("returns 2 when unhealthy", () => {
    expect(getCronSeverity(makeCron({ healthy: false }))).toBe(2);
  });

  it("returns 2 when last run errored", () => {
    expect(getCronSeverity(makeCron({ lastRun: run("error") }))).toBe(2);
  });

  it("returns 2 when an in-flight run is stale", () => {
    expect(
      getCronSeverity(makeCron({ inFlight: { startedAt: 1, updatedAt: 1, stale: true } })),
    ).toBe(2);
  });

  it("returns 1 when last run is degraded", () => {
    expect(getCronSeverity(makeCron({ lastRun: run("degraded") }))).toBe(1);
  });

  it("returns 0 when healthy with an ok last run", () => {
    expect(getCronSeverity(makeCron({ lastRun: run("ok") }))).toBe(0);
  });
});

describe("sortCronGroupsBySeverity", () => {
  function makeGroup(key: string, crons: CronStatus[]): CronGroup {
    return {
      key,
      title: key,
      badge: key,
      description: key,
      entries: crons.map((cron, i) => [`${key}-${i}`, cron]),
    };
  }

  it("orders groups by their highest-severity entry, descending", () => {
    const healthy = makeGroup("healthy", [makeCron({ lastRun: run("ok") })]);
    const degraded = makeGroup("degraded", [makeCron({ lastRun: run("degraded") })]);
    const unhealthy = makeGroup("unhealthy", [makeCron({ healthy: false })]);

    const sorted = sortCronGroupsBySeverity([healthy, degraded, unhealthy]);

    expect(sorted.map((g) => g.key)).toEqual(["unhealthy", "degraded", "healthy"]);
  });

  it("sorts entries within a group by descending severity", () => {
    const group = makeGroup("mixed", [
      makeCron({ lastRun: run("ok") }),
      makeCron({ healthy: false }),
      makeCron({ lastRun: run("degraded") }),
    ]);

    const [sorted] = sortCronGroupsBySeverity([group]);

    expect(sorted.entries.map(([, cron]) => getCronSeverity(cron))).toEqual([2, 1, 0]);
  });

  it("does not mutate the input groups or their entries", () => {
    const group = makeGroup("mixed", [makeCron({ lastRun: run("ok") }), makeCron({ healthy: false })]);
    const originalOrder = group.entries.map(([id]) => id);

    sortCronGroupsBySeverity([group]);

    expect(group.entries.map(([id]) => id)).toEqual(originalOrder);
  });

  it("returns an empty array for no groups", () => {
    expect(sortCronGroupsBySeverity([])).toEqual([]);
  });
});

describe("countConsecutiveStatus", () => {
  it("returns 0 for an empty run list", () => {
    expect(countConsecutiveStatus([], "error")).toBe(0);
  });

  it("counts a leading run of the matching status only", () => {
    expect(countConsecutiveStatus([run("error"), run("error"), run("ok"), run("error")], "error")).toBe(2);
  });

  it("returns the full length when every run matches", () => {
    expect(countConsecutiveStatus([run("error"), run("error"), run("error")], "error")).toBe(3);
  });

  it("returns 0 when the first run does not match", () => {
    expect(countConsecutiveStatus([run("ok"), run("error")], "error")).toBe(0);
  });
});

describe("getLastSuccessfulRun", () => {
  it("returns null for an empty run list", () => {
    expect(getLastSuccessfulRun([])).toBeNull();
  });

  it("returns null when all runs are errors", () => {
    expect(getLastSuccessfulRun([run("error"), run("skipped_locked")])).toBeNull();
  });

  it("returns the first ok run (recentRuns is DESC)", () => {
    const ok = run("ok");
    expect(getLastSuccessfulRun([run("error"), ok, run("ok")])).toBe(ok);
  });

  it("treats degraded as successful", () => {
    const degraded = run("degraded");
    expect(getLastSuccessfulRun([run("error"), degraded])).toBe(degraded);
  });
});

function makeStatus(overrides: Record<string, unknown>): StatusResponse {
  const base = {
    dataQuality: { missingPrices: 0, blacklistMissingAmounts: 0, onchainSupplyDivergences: 0 },
    reserveComposition: { status: "healthy", deferredCoins: 0 },
    sectionErrors: {},
  };
  return { ...base, ...overrides } as unknown as StatusResponse;
}

describe("deriveInitialPipelineTab", () => {
  it("returns quality when a data-quality metric is non-zero", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      dataQuality: { missingPrices: 1, blacklistMissingAmounts: 0, onchainSupplyDivergences: 0 },
    }))).toBe("quality");
  });

  it("returns markets when a price mismatch exists", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      coingeckoPriceDiff: { mismatchedCount: 2 },
    }))).toBe("markets");
  });

  it("returns reserves when reserve composition is unhealthy", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      reserveComposition: { status: "degraded", deferredCoins: 0 },
    }))).toBe("reserves");
  });

  it("returns yield when yield health is non-healthy", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      yieldHealth: { status: "degraded" },
    }))).toBe("yield");
  });

  it("returns storage when d1 usage section errored", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      sectionErrors: { d1Usage: true },
    }))).toBe("storage");
  });

  it("returns discovery when discovery candidates exist", () => {
    expect(deriveInitialPipelineTab(makeStatus({
      discoveryCandidates: [{}],
    }))).toBe("discovery");
  });

  it("falls through to quality when everything is clean", () => {
    expect(deriveInitialPipelineTab(makeStatus({}))).toBe("quality");
  });
});
