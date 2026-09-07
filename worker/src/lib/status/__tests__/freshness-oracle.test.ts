import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import {
  classifyFreshness,
  loadProducerFreshnessFacts,
  type FreshnessPolicy,
  type ProducerFreshnessFact,
} from "../freshness-oracle";

const NOW = 1_800_000_000;
const FACT: ProducerFreshnessFact = {
  job: "producer",
  lastSuccessAt: NOW,
  lastRunAt: NOW,
  expectedIntervalSec: 900,
  lastStatus: "ok",
};

function atAge(ageSec: number | null): ProducerFreshnessFact {
  return { ...FACT, lastSuccessAt: ageSec == null ? null : NOW - ageSec };
}

describe("classifyFreshness parity boundaries", () => {
  const legacyPolicies: Array<[string, FreshnessPolicy, number, number]> = [
    ["status x2", { watchAt: { multiplier: 2 }, staleAt: { multiplier: 2 } }, 1_800, 1_800],
    ["watchdog x2/x3", { watchAt: { multiplier: 2 }, staleAt: { multiplier: 3 } }, 1_800, 2_700],
    ["canary 4h", { watchAt: { absoluteSec: 14_400 }, staleAt: { absoluteSec: 14_400 } }, 14_400, 14_400],
    ["canary 48h", { watchAt: { absoluteSec: 172_800 }, staleAt: { absoluteSec: 172_800 } }, 172_800, 172_800],
    ["digest 8.5h due-after", { watchAt: { absoluteSec: 30_599 }, staleAt: { absoluteSec: 30_599 } }, 30_599, 30_599],
    ["DEWS 2h", { watchAt: { absoluteSec: 7_200 }, staleAt: { absoluteSec: 7_200 } }, 7_200, 7_200],
  ];

  it.each(legacyPolicies)("matches %s immediately around each threshold", (_name, policy, watchAt, staleAt) => {
    expect(classifyFreshness(atAge(watchAt), policy, NOW).state).toBe("fresh");
    if (staleAt > watchAt) {
      expect(classifyFreshness(atAge(watchAt + 1), policy, NOW).state).toBe("watch");
      expect(classifyFreshness(atAge(staleAt), policy, NOW).state).toBe("watch");
    }
    expect(classifyFreshness(atAge(staleAt + 1), policy, NOW).state).toBe("stale");
    expect(classifyFreshness(atAge(null), policy, NOW).state).toBe("stale");
  });
});

describe("loadProducerFreshnessFacts", () => {
  it("loads all producer facts with one statement and retains missing producers", async () => {
    const all = vi.fn(async () => ({ results: [{
      job: "alpha",
      last_success_at: NOW - 10,
      last_run_at: NOW - 5,
      last_status: "error",
    }] }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;
    const facts = await loadProducerFreshnessFacts(db, NOW, [
      {
        job: "alpha", label: "Alpha", group: "other", intervalSec: 60,
        scheduleKey: "daily0300Utc", schedule: "0 3 * * *", triggerMode: "isolated", statusImpact: "watch",
        freshnessSurface: "consumer",
      },
      {
        job: "beta", label: "Beta", group: "other", intervalSec: 120,
        scheduleKey: "daily0300Utc", schedule: "0 3 * * *", triggerMode: "isolated", statusImpact: "watch",
        freshnessSurface: "consumer",
      },
    ]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
    expect(facts).toEqual([
      {
        job: "alpha", lastSuccessAt: NOW - 10, lastRunAt: NOW - 5,
        expectedIntervalSec: 60, lastStatus: "error",
      },
      {
        job: "beta", lastSuccessAt: null, lastRunAt: null,
        expectedIntervalSec: 120, lastStatus: null,
      },
    ]);
  });

  it("selects the latest status and latest successful clock from real SQLite", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL
    )`);
    sqlite.prepare("INSERT INTO cron_runs (job, started_at, status) VALUES (?, ?, ?)")
      .run("alpha", NOW - 30, "ok");
    sqlite.prepare("INSERT INTO cron_runs (job, started_at, status) VALUES (?, ?, ?)")
      .run("alpha", NOW - 10, "error");
    const [fact] = await loadProducerFreshnessFacts(createSqliteD1(sqlite), NOW, [{
      job: "alpha", label: "Alpha", group: "other", intervalSec: 60,
      scheduleKey: "daily0300Utc", schedule: "0 3 * * *", triggerMode: "isolated", statusImpact: "watch",
      freshnessSurface: "consumer",
    }]);
    sqlite.close();

    expect(fact).toMatchObject({
      lastSuccessAt: NOW - 30,
      lastRunAt: NOW - 10,
      lastStatus: "error",
    });
  });
});
