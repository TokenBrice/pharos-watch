import { describe, expect, it } from "vitest";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../../public-health-assessment";
import type { CronHealthSnapshot } from "../cron-health";
import { makeCronHealth } from "./cron-health.test-support";
import { buildStatusSummary } from "../summary";
import { mockReserveD1 } from "../../__tests__/live-reserves-store.test-support";
import {
  applyCronHealthSectionErrors,
  countStatusDiagnosticIssues,
  loadSupplementalStatusSections,
} from "../evaluation-context";

const PUBLIC_HEALTH = {
  cacheFailures: [],
  mintBurnQueryError: null,
  circuitQueryError: null,
} as unknown as PublicHealthAssessment;

const DATA_QUALITY = {
  sourceFailures: [],
} as unknown as DataQuality;


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
  it("names failed history in section errors and summary while retaining successful companion evidence", () => {
    const cronHealth = makeCronHealth({ cronHistoryQueryFailed: true, scheduledSlots: { runningSlots: 2 } });
    expect(countIssues(cronHealth)).toBe(1);
    expect(getSectionErrors(cronHealth)).toEqual({
      crons: { code: "cron-history-read-failed", message: expect.any(String) },
    });
    expect(buildStatusSummary({
      cronHealth, budgetOnlySurfaces: [], diagnosticIssueCount: 1,
      worstCacheRatio: 0, transitionsLast24h: 0,
    })).toMatchObject({
      cronHistoryUnavailableReason: "cron-history-read-failed",
      unhealthyCrons: null, cronErrors: null, expiredCronLeases: 0, scheduledSlotRunning: 2,
    });
  });
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

describe("reserve checkpoint read availability", () => {
  it("reports reserve overview unavailable when its checkpoint read fails", async () => {
    const db = mockReserveD1([{
      match: "FROM worker_scheduled_checkpoints", rows: [], throwError: new Error("checkpoint-read-failed"),
    }]);
    const sections = await loadSupplementalStatusSections(db, 10_000);
    expect(sections.reserveCompositionQueryFailed).toBe(true);
    expect(sections.reserveComposition).toMatchObject({
      status: "unavailable", reason: "reserve_composition_query_failed",
      inProgressCoins: null, deferredCoins: null, runBudgetTruncated: null,
    });
    expect(sections.sectionErrors.reserveComposition?.code).toBe("reserve_composition_query_failed");
  });

  it("keeps successfully absent checkpoint distinct from unreadable checkpoint", async () => {
    const sections = await loadSupplementalStatusSections(mockReserveD1(), 10_000);
    expect(sections.reserveCompositionQueryFailed).toBe(false);
    expect(sections.sectionErrors.reserveComposition).toBeUndefined();
    expect(sections.reserveComposition.inProgressCoins).toBe(0);
  });
});
