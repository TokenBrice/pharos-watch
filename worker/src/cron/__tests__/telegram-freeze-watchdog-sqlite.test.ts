import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFreezeIdentityFixture } from "./telegram-alert-freeze.test-support";
import { dispatchFreezeAlertOutbox } from "../telegram-freeze-outbox";
import { buildDispatchResult } from "../dispatch-telegram-result";
import { runTelegramDegradationWatchdog, WATCHDOG_KEYS } from "../telegram-degradation-watchdog";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9/consumer-freshness";
import { parseTelegramDispatchCronMetadata } from "@shared/lib/status-metadata";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function healthySafety(now: number) {
  return {
    state: "ok" as const, ageSeconds: 0, generation: "generation", envelope: null,
    sourcePublicationGenerationId: "generation", acceptedPublicationGenerationId: "generation",
    freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec: now,
  };
}

describe("freeze audience zero-send watchdog", () => {
  it.each([false, true])("qualifies three distinct freeze runs using durable recipient work (audience=%s)", async (audience) => {
    const { sqlite, db, now, insertFreeze } = await createFreezeIdentityFixture();
    vi.setSystemTime(now * 1000);
    try {
      if (!audience) sqlite.prepare("UPDATE telegram_subscribers SET global_alert_freeze = 0").run();
      for (let run = 1; run <= 3; run++) {
        insertFreeze(`watchdog-${run}`, now + run);
        const freeze = await dispatchFreezeAlertOutbox(db, now + run);
        expect(freeze.observed).toBe(1);
        expect(freeze.targetCount).toBe(audience ? 1 : 0);
        expect(freeze.queued).toBe(audience ? 1 : 0);
        const result = buildDispatchResult({
          snapshotSeeded: false, eventOverrides: { freeze: freeze.observed },
          overrides: { freezeTargetCount: freeze.targetCount },
        });
        expect(parseTelegramDispatchCronMetadata(result)?.freezeTargetCount).toBe(audience ? 1 : 0);
        sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
          VALUES ('dispatch-telegram-alerts', ?, 1, 'ok', ?)`)
          .run(now + run, JSON.stringify(result));
        const watchdog = await runTelegramDegradationWatchdog(db, undefined, { safetySourceAssessment: healthySafety(now) });
        const metadata = JSON.parse(watchdog.metadata ?? "{}");
        expect(metadata.zeroSend).toMatchObject({
          evaluated: true, streak: audience ? run : 0, triggered: audience && run === 3,
        });
        expect(watchdog.status).toBe(audience && run === 3 ? "degraded" : "ok");
      }
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_freeze_alert_targets").get())
        .toEqual({ count: audience ? 3 : 0 });
    } finally {
      sqlite.close();
    }
  });

  it.each([undefined, "invalid"])("preserves the streak when freeze audience metadata is %s", async (freezeTargetCount) => {
    const { sqlite, db, now } = await createFreezeIdentityFixture();
    vi.setSystemTime(now * 1000);
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(WATCHDOG_KEYS.zeroSendStreak, JSON.stringify({ streak: 2, lastRunIdentity: "old" }), now);
      const result = buildDispatchResult({ snapshotSeeded: false, eventOverrides: { freeze: 1 } });
      const metadata: Record<string, unknown> = { ...result };
      if (freezeTargetCount === undefined) delete metadata.freezeTargetCount;
      else metadata.freezeTargetCount = freezeTargetCount;
      sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
        VALUES ('dispatch-telegram-alerts', ?, 1, 'ok', ?)`)
        .run(now, JSON.stringify(metadata));
      const watchdog = await runTelegramDegradationWatchdog(db, undefined, { safetySourceAssessment: healthySafety(now) });
      expect(JSON.parse(watchdog.metadata ?? "{}").zeroSend).toMatchObject({ evaluated: false, streak: 2 });
    } finally {
      sqlite.close();
    }
  });
});
