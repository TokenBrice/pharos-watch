import { describe, expect, it } from "vitest";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../../public-health-assessment";
import type { CronHealthSnapshot } from "../cron-health";
import {
  applyCronHealthSectionErrors,
  countStatusDiagnosticIssues,
} from "../evaluation-context";

const PUBLIC_HEALTH = {
  cacheFailures: [],
  mintBurnQueryError: null,
  circuitQueryError: null,
} as unknown as PublicHealthAssessment;

const DATA_QUALITY = {
  sourceFailures: [],
} as unknown as DataQuality;

function makeCronHealth(
  overrides?: {
    scheduledSlots?: Partial<CronHealthSnapshot["scheduledSlots"]>;
    scheduledSlotEventMarkerQueryFailed?: boolean;
  },
): CronHealthSnapshot {
  return {
    crons: {},
    unhealthyCrons: 0,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 0,
    degradedCronRuns: 0,
    cronErrorCount: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    staleCronArtifacts: 0,
    expiredCronLeases: 0,
    orphanedCronProgressRows: 0,
    activeJobAttempts: 0,
    staleJobAttempts: 0,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
    jobAttemptQueryFailed: false,
    scheduledSlotEventMarkerQueryFailed: overrides?.scheduledSlotEventMarkerQueryFailed ?? false,
    scheduledSlots: {
      runningSlots: 0,
      staleCandidateSlots: 0,
      oldestRunningAgeSec: null,
      oldestStaleAgeSec: null,
      queryFailed: false,
      ...(overrides?.scheduledSlots ?? {}),
    },
  };
}

function countIssues(cronHealth: CronHealthSnapshot): number {
  return countStatusDiagnosticIssues({
    publicHealth: PUBLIC_HEALTH,
    dataQuality: DATA_QUALITY,
    reserveCompositionQueryFailed: false,
    cronHealth,
  });
}

function getSectionErrors(cronHealth: CronHealthSnapshot): StatusResponse["sectionErrors"] {
  const sectionErrors: StatusResponse["sectionErrors"] = {};
  applyCronHealthSectionErrors(sectionErrors, cronHealth);
  return sectionErrors;
}

function expectScheduledSlotSectionError(
  cronHealth: CronHealthSnapshot,
  code: string,
): void {
  const sectionErrors = getSectionErrors(cronHealth);
  expect(sectionErrors.scheduledSlots?.code).toBe(code);
  expect(sectionErrors.scheduledSlots?.message).toEqual(expect.any(String));
}

describe("status evaluation scheduled-slot query failures", () => {
  it("counts and surfaces running-slot query failure alone", () => {
    const cronHealth = makeCronHealth({ scheduledSlots: { queryFailed: true } });

    expect(countIssues(cronHealth)).toBe(1);
    expectScheduledSlotSectionError(cronHealth, "scheduled_slot_running_query_failed");
  });

  it("counts and surfaces event-marker query failure alone", () => {
    const cronHealth = makeCronHealth({ scheduledSlotEventMarkerQueryFailed: true });

    expect(countIssues(cronHealth)).toBe(1);
    expectScheduledSlotSectionError(cronHealth, "scheduled_slot_event_marker_query_failed");
  });

  it("counts both scheduled-slot query failures together", () => {
    const cronHealth = makeCronHealth({
      scheduledSlots: { queryFailed: true },
      scheduledSlotEventMarkerQueryFailed: true,
    });

    expect(countIssues(cronHealth)).toBe(2);
    expectScheduledSlotSectionError(cronHealth, "scheduled_slot_queries_failed");
  });

  it("leaves diagnostics and section errors unchanged when both reads succeed", () => {
    const cronHealth = makeCronHealth();

    expect(countIssues(cronHealth)).toBe(0);
    expect(getSectionErrors(cronHealth)).toEqual({});
  });
});
