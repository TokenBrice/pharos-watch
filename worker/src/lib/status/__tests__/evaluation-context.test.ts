import { afterEach, describe, expect, it } from "vitest";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
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

describe("status evaluation Telegram bot fan-out", () => {
  const fixtures = createLatestSchemaFixtureTracker();
  afterEach(fixtures.closeAll);

  it("publishes Telegram-table telemetry when only the stablecoins cache blocks preset ranking", async () => {
    const { sqlite, db } = fixtures.open();
    const nowSec = 1_771_833_600;

    sqlite.exec(`
      INSERT INTO telegram_subscribers
        (chat_id, created_at, last_active_at, global_alert_dews, quiet_hours_enabled)
      VALUES
        ('chat-a', ${nowSec - 600}, ${nowSec - 30}, 1, 0),
        ('chat-b', ${nowSec - 500}, ${nowSec - 60}, 1, 1),
        ('chat-c', ${nowSec - 400}, ${nowSec - 90}, 0, 0);

      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews)
      VALUES
        ('chat-a', 'usdc-circle', 1),
        ('chat-b', 'usdc-circle', 1),
        ('chat-c', 'usde-ethena', 1);

      INSERT INTO telegram_preset_subscriptions
        (chat_id, preset_id, alert_dews, created_at, updated_at)
      VALUES
        ('chat-a', 'mcap-ge-1b', 1, ${nowSec - 600}, ${nowSec - 600}),
        ('chat-b', 'mcap-ge-1b', 1, ${nowSec - 500}, ${nowSec - 500});

      INSERT INTO telegram_deliveries
        (job_id, kind, chat_id, body_hash, state, next_attempt_at, expires_at, created_at, error_class)
      VALUES
        ('job-1', 'depeg', 'chat-a', 'hash-a', 'retry', ${nowSec}, ${nowSec + 3600}, ${nowSec - 60}, 'blocked'),
        ('job-1', 'depeg', 'chat-b', 'hash-b', 'pending', ${nowSec}, ${nowSec + 3600}, ${nowSec - 60}, NULL),
        ('job-1', 'depeg', 'chat-c', 'hash-c', 'sent', ${nowSec}, ${nowSec + 3600}, ${nowSec - 60}, NULL);

      INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count)
      VALUES ('telegram-inactive-cleanup', ${nowSec - 3600}, 500, 'ok', 6);
    `);

    // Deliberately no `cache` row for the `stablecoins` key. `resolveTelegramPresetTargets`
    // reads that shared cache, not a Telegram table, so only the preset-implied ranking
    // is unavailable; every Telegram table read below succeeds.
    const sections = await loadSupplementalStatusSections(db, nowSec);

    expect(sections.sectionErrors.telegramBot).toBeUndefined();
    expect(sections.telegramBot).not.toBeNull();

    const stats = sections.telegramBot;
    if (!stats) throw new Error("expected telegramBot section to be published");

    // Telegram-table evidence still reaches the published section.
    expect(stats).toMatchObject({
      totalChats: 3,
      pendingDeliveries: 2,
      retryErrorClassCounts: { blocked: 1 },
      pendingDeliveryBacklog: { due: 2, deferred: 0, expired: 0 },
      inactiveSubscribersCleanedThisWeek: 6,
    });
    expect(stats.lifecycleSnapshot).toMatchObject({
      date: "2026-02-23",
      activeWatchers: 3,
      pendingDeliveries: 2,
    });

    // A failed stablecoins-cache read must not become a zero ranking or a zero
    // total: the ranking is unavailable and the total stays unknown.
    expect(stats.topStablecoins).toEqual([]);
    expect(stats.totalSubscriptions).toBeNull();
    expect(stats.quality).toMatchObject({ status: "partial" });
    expect(stats.quality?.unavailableFields).toEqual(
      expect.arrayContaining([expect.stringMatching(/top/i)]),
    );
  });
});
