import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cacheStore, sendAlertMock, sweepMock } = vi.hoisted(() => ({
  cacheStore: new Map<string, { value: string; updatedAt: number }>(),
  sendAlertMock: vi.fn(),
  sweepMock: vi.fn(),
}));

vi.mock("../../lib/alerts", () => ({
  sendAlert: sendAlertMock,
}));

vi.mock("../../lib/cron-lease", () => ({
  sweepStaleScheduledSlotExecutions: sweepMock,
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db: D1Database, key: string) => cacheStore.get(key) ?? null),
  setCache: vi.fn(async (_db: D1Database, key: string, value: string) => {
    cacheStore.set(key, { value, updatedAt: Math.floor(Date.now() / 1000) });
  }),
}));

import { runCronSlotSweeper } from "../cron-slot-sweeper";

const DIRECT_ALERT_KEY = "cron-slot-sweeper:alert:scheduled-slot-abandoned:direct:v1";
const LEGACY_ALERT_KEY = "cron-slot-sweeper:alert:scheduled-slot-abandoned";

function abandonedSummary() {
  return {
    staleBefore: 1_699_999_100,
    candidateSlots: 1,
    slotsReconciled: 1,
    syntheticCronRuns: 2,
    jobAttemptsAbandoned: 2,
    progressRowsCleared: 1,
    leasesCleared: 1,
    recoveryCheckpointsPrepared: 0,
    notStartedCronRuns: 0,
    abandonedSlots: [
      {
        slotKey: "quarterHourlyCore",
        slotStartedAt: 1_699_999_000,
        slotOwner: "owner-1",
        slotUpdatedAt: 1_699_999_010,
        abandonedJobs: [{ job: "sync-stablecoins" }],
      },
    ],
  };
}

describe("runCronSlotSweeper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T03:00:00Z"));
    cacheStore.clear();
    sendAlertMock.mockReset().mockResolvedValue(true);
    sweepMock.mockReset().mockResolvedValue(abandonedSummary());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores the legacy marker and records successful direct delivery", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    cacheStore.set(LEGACY_ALERT_KEY, { value: JSON.stringify({ lastAlertedAt: nowSec }), updatedAt: nowSec });

    const result = await runCronSlotSweeper({} as D1Database, "https://alerts.example/webhook");

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cacheStore.get(DIRECT_ALERT_KEY)?.value ?? "{}")).toMatchObject({
      lastAlertedAt: nowSec,
      slotsReconciled: 1,
      syntheticCronRuns: 2,
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      alertDelivered: true,
      alertSuppressed: false,
    });
  });

  it("does not advance the direct marker when delivery fails", async () => {
    sendAlertMock.mockResolvedValueOnce(false);

    const result = await runCronSlotSweeper({} as D1Database, "https://alerts.example/webhook");

    expect(cacheStore.has(DIRECT_ALERT_KEY)).toBe(false);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      alertDelivered: false,
      alertSuppressed: false,
    });
  });

  it("suppresses delivery inside the direct-marker cooldown", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    cacheStore.set(DIRECT_ALERT_KEY, { value: JSON.stringify({ lastAlertedAt: nowSec }), updatedAt: nowSec - 60 });

    const result = await runCronSlotSweeper({} as D1Database, "https://alerts.example/webhook");

    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      alertDelivered: false,
      alertSuppressed: true,
    });
  });
});
