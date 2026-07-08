import { describe, expect, it } from "vitest";
import type { CronHealthSnapshot } from "../cron-health";
import { buildStatusSummary, emptyStatusSummary } from "../summary";

function makeCronHealth(
  overrides?: {
    scheduledSlots?: Partial<CronHealthSnapshot["scheduledSlots"]>;
    scheduledSlotEventMarkerQueryFailed?: boolean;
  },
): CronHealthSnapshot {
  return {
    crons: {},
    unhealthyCrons: 1,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 1,
    degradedCronRuns: 2,
    cronErrorCount: 3,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    staleCronArtifacts: 4,
    expiredCronLeases: 1,
    orphanedCronProgressRows: 3,
    activeJobAttempts: 5,
    staleJobAttempts: 6,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
    jobAttemptQueryFailed: false,
    scheduledSlotEventMarkerQueryFailed: overrides?.scheduledSlotEventMarkerQueryFailed ?? false,
    scheduledSlots: {
      runningSlots: 7,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: 30,
      oldestStaleAgeSec: null,
      queryFailed: false,
      ...(overrides?.scheduledSlots ?? {}),
    },
  };
}

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
  it("keeps the no-failure summary shape unchanged", () => {
    const summary = buildSummary(makeCronHealth());

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
      activeJobAttempts: 5,
      staleJobAttempts: 6,
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

  it("surfaces both scheduled-slot query failures together", () => {
    const summary = buildSummary(makeCronHealth({
      scheduledSlots: { queryFailed: true },
      scheduledSlotEventMarkerQueryFailed: true,
    }));

    expect(summary.scheduledSlotRunningQueryFailed).toBe(true);
    expect(summary.scheduledSlotEventMarkerQueryFailed).toBe(true);
  });
});
