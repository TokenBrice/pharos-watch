import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { enqueueTelegramJob } from "../../../../telegram/delivery/jobs";
import { drainTelegramDeliveries } from "../../../../telegram/delivery/job-drain";
import type { SendToChatResult } from "../../../../telegram/delivery/telegram";
import type { TelegramDispatchEvents } from "../../sources/dispatch-telegram-events";
import { buildTelegramAlertJobSpec } from "../alert-job";
import { fanOutPlanningTelegramJobs } from "../run-jobs";

const NOW = 1_900_000_000;
const open: DatabaseSync[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function fixture() {
  const { sqlite } = createLatestSchemaSqlite();
  open.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function depegEvents(deviationBps: number): TelegramDispatchEvents {
  return {
    dewsChanges: [],
    depegTriggered: [{
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      direction: "below",
      deviationBps,
      price: 1 - deviationBps / 10_000,
      pegReference: 1,
    }],
    depegResolved: [],
    depegWorsening: [],
    safetyChanges: [],
    reservePromoted: [],
    suppressedMethodologyChanges: 0,
    dewsIds: [],
    depegIds: ["usdt-tether"],
    safetyIds: [],
    reserveIds: [],
  };
}

const ok: SendToChatResult = {
  ok: true, blocked: false, retryable: false, permanentFailure: false, statusCode: 200,
  errorClass: null, delivery: "sent", retryAfterSec: null,
};

function addDirectFollower(sqlite: DatabaseSync, chatId: string) {
  sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)")
    .run(chatId, NOW, NOW);
  sqlite.prepare("INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg) VALUES (?, 'usdt-tether', 1)")
    .run(chatId);
}

describe("alert job fan-out", () => {
  it("derives a deterministic job id, renders through the existing formatter and suppresses replayed bodies", async () => {
    const { sqlite, db } = fixture();
    addDirectFollower(sqlite, "100");
    addDirectFollower(sqlite, "200");
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('300', ?, ?)").run(NOW, NOW);

    const spec = await buildTelegramAlertJobSpec({ events: depegEvents(250), baselineDigestInput: "b1", detectedAt: NOW });
    const replay = await buildTelegramAlertJobSpec({ events: depegEvents(250), baselineDigestInput: "b1", detectedAt: NOW });
    expect(replay.jobId).toBe(spec.jobId);
    expect(spec.expiresAt).toBe(NOW + 2 * 60 * 60);
    await enqueueTelegramJob(db, spec);
    await enqueueTelegramJob(db, replay);
    await fanOutPlanningTelegramJobs(db, NOW);
    const rows = sqlite.prepare("SELECT chat_id, state, families, coin_ids, body FROM telegram_deliveries ORDER BY chat_id")
      .all() as Array<Record<string, string>>;
    expect(rows.map((row) => [row.chat_id, row.state, row.families, row.coin_ids])).toEqual([
      ["100", "pending", "depeg", "usdt-tether"],
      ["200", "pending", "depeg", "usdt-tether"],
    ]);
    expect(rows[0]!.body).toContain("USDT");
    await drainTelegramDeliveries(db, "token", { nowSec: () => NOW, sendMessage: async () => ok });

    // The same detection re-emitted later (a flap back to an identical body) is suppressed.
    const flap = await buildTelegramAlertJobSpec({ events: depegEvents(250), baselineDigestInput: "b2", detectedAt: NOW + 900 });
    expect(flap.jobId).not.toBe(spec.jobId);
    await enqueueTelegramJob(db, flap);
    const fanout = await fanOutPlanningTelegramJobs(db, NOW + 900);
    expect(fanout.suppressedDuplicate).toBe(2);
    expect(sqlite.prepare("SELECT state, COUNT(*) AS n FROM telegram_deliveries WHERE job_id = ? GROUP BY state").all(flap.jobId))
      .toEqual([{ state: "suppressed_duplicate", n: 2 }]);
  });

  it("fails closed when preset membership cannot be resolved", async () => {
    const { sqlite, db } = fixture();
    addDirectFollower(sqlite, "100");
    sqlite.prepare(
      `INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_depeg, created_at, updated_at)
       VALUES ('100', 'usd-top25', 1, 1, 1)`,
    ).run();
    // No stablecoins cache: preset resolution cannot run.
    const spec = await buildTelegramAlertJobSpec({ events: depegEvents(250), baselineDigestInput: "b", detectedAt: NOW });
    await enqueueTelegramJob(db, spec);
    const result = await fanOutPlanningTelegramJobs(db, NOW);
    expect(result).toMatchObject({ jobsFailedClosed: 1, deliveriesPlanned: 0 });
    expect(sqlite.prepare("SELECT state FROM telegram_jobs").get()).toEqual({ state: "planning" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_deliveries").get()).toEqual({ n: 0 });
  });

  it("retains the durable cursor after a failed page and plans each chat once on retry", async () => {
    const { sqlite, db } = fixture();
    addDirectFollower(sqlite, "100");
    addDirectFollower(sqlite, "200");
    const spec = await buildTelegramAlertJobSpec({ events: depegEvents(250), baselineDigestInput: "b", detectedAt: NOW });
    await enqueueTelegramJob(db, spec);
    // The page's atomic row/cursor batch fails once.
    let failNextBatch = true;
    const flaky = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (failNextBatch) {
              failNextBatch = false;
              throw new Error("D1 batch unavailable");
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await fanOutPlanningTelegramJobs(flaky, NOW)).toMatchObject({ jobsFailedClosed: 1, deliveriesPlanned: 0 });
    expect(sqlite.prepare("SELECT state, cursor, planned_count FROM telegram_jobs").get())
      .toEqual({ state: "planning", cursor: null, planned_count: 0 });

    expect(await fanOutPlanningTelegramJobs(flaky, NOW + 300)).toMatchObject({ jobsFailedClosed: 0, deliveriesPlanned: 2 });
    expect(await fanOutPlanningTelegramJobs(flaky, NOW + 600)).toMatchObject({ deliveriesPlanned: 0 });
    expect(sqlite.prepare("SELECT chat_id, COUNT(*) AS n FROM telegram_deliveries GROUP BY chat_id ORDER BY chat_id").all())
      .toEqual([{ chat_id: "100", n: 1 }, { chat_id: "200", n: 1 }]);
    expect(sqlite.prepare("SELECT state, error FROM telegram_jobs").get()).toEqual({ state: "ready", error: null });
  });
});
