import { describe, expect, it } from "vitest";
import type { CronHealthSnapshot } from "../cron-health";
import { buildStatusSummary, emptyStatusSummary } from "../summary";
import { makeCronHealth } from "./cron-health.test-support";


function buildSummary(cronHealth: CronHealthSnapshot) {
  return buildStatusSummary({
    cronHealth,
    budgetOnlySurfaces: [],
    diagnosticIssueCount: 0,
    worstCacheRatio: 0,
    transitionsLast24h: 0,
  });
}

describe("status summary scheduled-slot query failures", () => {
  it("keeps all skipped DB summary measurements unavailable", () => {
    const summary = emptyStatusSummary();
    expect(summary.unavailableReason).toBe("db-unavailable");
    for (const [key, value] of Object.entries(summary)) {
      if (key !== "unavailableReason" && key !== "transitionsUnavailableReason") expect(value, key).toBeNull();
    }
  });
  it.each([null, 99])("serializes freshness ratio availability without sentinel substitution (%s)", (worstCacheRatio) => {
    const summary = buildStatusSummary({ cronHealth: makeCronHealth(), budgetOnlySurfaces: [],
      diagnosticIssueCount: 0, transitionsLast24h: 0, worstCacheRatio });
    expect(JSON.parse(JSON.stringify(summary)).worstCacheRatio).toBe(worstCacheRatio);
    expect(emptyStatusSummary().worstCacheRatio).toBeNull();
  });
  it("keeps the no-failure summary shape unchanged", () => {
    const summary = buildSummary(makeCronHealth({
      unhealthyCrons: 1, watchUnhealthyCrons: 1, degradedCronRuns: 2, cronErrorCount: 3,
      staleCronArtifacts: 4, expiredCronLeases: 1, orphanedCronProgressRows: 3,
      scheduledSlots: { runningSlots: 7, oldestRunningAgeSec: 30 },
    }));

    expect(summary).toEqual({
      unhealthyCrons: 1,
      availabilityImpactingUnhealthyCrons: 0,
      watchUnhealthyCrons: 1,
      degradedCrons: 2,
      cronErrors: 3,
      availabilityImpactingCronErrors: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
      staleCronArtifacts: 4,
      expiredCronLeases: 1,
      orphanedCronProgressRows: 3,
      scheduledSlotRunning: 7,
      scheduledSlotStaleCandidates: 0,
      scheduledSlotOldestRunningAgeSec: 30,
      budgetOnlySurfaceCount: 0,
      budgetOnlySurfaceMissingTelemetry: 0,
      budgetOnlySurfaceStaleTelemetry: 0,
      budgetOnlySurfaceErrors: 0,
      diagnosticIssueCount: 0,
      worstCacheRatio: 0,
      transitionsLast24h: 0,
      transitionsUnavailableReason: null,
      cronHistoryUnavailableReason: null,
    });
    expect(summary).not.toHaveProperty("scheduledSlotRunningQueryFailed");
    expect(summary).not.toHaveProperty("scheduledSlotEventMarkerQueryFailed");
    expect(emptyStatusSummary()).not.toHaveProperty("scheduledSlotRunningQueryFailed");
    expect(emptyStatusSummary()).not.toHaveProperty("scheduledSlotEventMarkerQueryFailed");
  });

  it("surfaces running-slot query failure alone", () => {
    const summary = buildSummary(makeCronHealth({ scheduledSlots: { queryFailed: true } }));

    expect(summary.scheduledSlotRunningQueryFailed).toBe(true);
    expect(summary).not.toHaveProperty("scheduledSlotEventMarkerQueryFailed");
  });

  it("surfaces event-marker query failure alone", () => {
    const summary = buildSummary(makeCronHealth({ scheduledSlotEventMarkerQueryFailed: true }));

    expect(summary.scheduledSlotEventMarkerQueryFailed).toBe(true);
    expect(summary).not.toHaveProperty("scheduledSlotRunningQueryFailed");
  });

  it("projects failed history as unavailable without hiding independently read artifacts and slots", () => {
    const summary = buildSummary(makeCronHealth({
      cronHistoryQueryFailed: true,
      expiredCronLeases: 2,
      orphanedCronProgressRows: 3,
      staleCronArtifacts: 5,
      scheduledSlots: { runningSlots: 7 },
    }));
    expect(summary).toMatchObject({
      unhealthyCrons: null, availabilityImpactingUnhealthyCrons: null, watchUnhealthyCrons: null,
      degradedCrons: null, cronErrors: null, availabilityImpactingCronErrors: null,
      availabilityImpactingConsecutiveCronErrors: null, cronHistoryUnavailableReason: "cron-history-read-failed",
      expiredCronLeases: 2, orphanedCronProgressRows: 3, staleCronArtifacts: 5, scheduledSlotRunning: 7,
    });
    expect(summary.unavailableReason).toBeUndefined();
  });

  it.each([
    [{ cronLeaseQueryFailed: true }, { expiredCronLeases: null, orphanedCronProgressRows: null, staleCronArtifacts: null }],
    [{ cronProgressQueryFailed: true }, { expiredCronLeases: 0, orphanedCronProgressRows: null, staleCronArtifacts: null }],
    [{ scheduledSlots: { queryFailed: true } }, { scheduledSlotRunning: null, scheduledSlotStaleCandidates: null, scheduledSlotOldestRunningAgeSec: null }],
  ])("keeps failed companion aggregates independent of successful empty history", (failures, unavailable) => {
    const summary = buildSummary(makeCronHealth(failures));
    expect(summary).toMatchObject({
      ...unavailable, unhealthyCrons: 0, cronErrors: 0, degradedCrons: 0, cronHistoryUnavailableReason: null,
    });
  });

});
