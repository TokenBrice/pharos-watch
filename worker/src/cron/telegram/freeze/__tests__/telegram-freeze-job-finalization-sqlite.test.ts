import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFreezeIdentityFixture } from "./telegram-alert-freeze.test-support";
import { dispatchFreezeAlertOutbox } from "../telegram-freeze-outbox";
import {
  reconcileExpiredTelegramAlertJobTargets,
  recordTelegramAlertTargetStatuses,
} from "../../delivery/telegram-alert-target-status";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("freeze job finalization", () => {
  it("finalizes freeze jobs whose targets settle after handoff", async () => {
    const { sqlite, db, now, insertFreeze } = await createFreezeIdentityFixture();
    vi.setSystemTime(now * 1000);
    try {
      insertFreeze("expires", now + 1);
      insertFreeze("delivered", now + 2);
      expect((await dispatchFreezeAlertOutbox(db, now + 2)).queued).toBe(2);
      const targets = sqlite.prepare(
        `SELECT target.pending_dedupe_key, target.source_event_id, target.enqueued_at, event.tape_event_id
           FROM telegram_alert_job_targets target
           JOIN telegram_freeze_alert_events event ON event.source_event_id = target.source_event_id
          WHERE target.alert_type = 'freeze'`,
      ).all() as Array<{ pending_dedupe_key: string; source_event_id: string; enqueued_at: number | null; tape_event_id: string }>;
      expect(targets).toHaveLength(2);
      expect(targets.every((target) => target.enqueued_at === now + 2)).toBe(true);
      const delivered = targets.find((target) => target.tape_event_id === "delivered")!;

      // Drain telemetry marks the delivered target sent without a final projection.
      await recordTelegramAlertTargetStatuses(db, [{
        targetKey: delivered.pending_dedupe_key, sourceEventId: delivered.source_event_id, status: "sent", at: now + 3,
      }]);
      sqlite.prepare("DELETE FROM telegram_pending_alerts").run();
      expect(sqlite.prepare("SELECT DISTINCT status FROM telegram_alert_jobs WHERE alert_type = 'freeze'").all())
        .toEqual([{ status: "queued" }]);

      // The TTL sweep expires the other target and then reconciles both settled jobs.
      expect(await reconcileExpiredTelegramAlertJobTargets(db, now + 30 * 86_400)).toBe(1);
      const jobs = sqlite.prepare(
        `SELECT event.tape_event_id, job.status, job.sent_count, job.expired_count, job.enqueued_count
           FROM telegram_alert_jobs job
           JOIN telegram_freeze_alert_events event ON event.source_event_id = job.source_event_id
          WHERE job.alert_type = 'freeze'
          ORDER BY event.tape_event_id`,
      ).all();
      expect(jobs).toEqual([
        { tape_event_id: "delivered", status: "sent", sent_count: 1, expired_count: 0, enqueued_count: 0 },
        { tape_event_id: "expires", status: "degraded", sent_count: 0, expired_count: 1, enqueued_count: 0 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("finalizes freeze jobs whose event expired after a partial handoff", async () => {
    const { sqlite, db, now, insertFreeze } = await createFreezeIdentityFixture();
    vi.setSystemTime(now * 1000);
    try {
      insertFreeze("partial", now + 1);
      await dispatchFreezeAlertOutbox(db, now + 1);
      // The event expires before the rest of its cohort is handed off.
      sqlite.prepare("UPDATE telegram_freeze_alert_events SET status = 'expired' WHERE tape_event_id = 'partial'").run();
      expect(await reconcileExpiredTelegramAlertJobTargets(db, now + 30 * 86_400)).toBe(1);
      expect(sqlite.prepare(
        `SELECT job.status, job.expired_count
           FROM telegram_alert_jobs job
           JOIN telegram_freeze_alert_events event ON event.source_event_id = job.source_event_id
          WHERE event.tape_event_id = 'partial'`,
      ).all()).toEqual([{ status: "degraded", expired_count: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  it("leaves freeze jobs with queued targets untouched", async () => {
    const { sqlite, db, now, insertFreeze } = await createFreezeIdentityFixture();
    vi.setSystemTime(now * 1000);
    try {
      insertFreeze("in-flight", now + 1);
      await dispatchFreezeAlertOutbox(db, now + 1);
      expect(await reconcileExpiredTelegramAlertJobTargets(db, now + 2)).toBe(0);
      expect(sqlite.prepare("SELECT status, enqueued_count FROM telegram_alert_jobs WHERE alert_type = 'freeze'").all())
        .toEqual([{ status: "queued", enqueued_count: 1 }]);
    } finally {
      sqlite.close();
    }
  });
});
