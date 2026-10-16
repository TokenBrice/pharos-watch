import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { cachedPulse as buildCachedPulse, pulseAggregate } from "./telegram-pulse.test-support";

const fixtures = createLatestSchemaFixtureTracker();
function persistedPulseDb() {
  const fixture = fixtures.open();
  fixture.sqlite.exec(`
    INSERT INTO telegram_watcher_lifecycle_daily (day, snapshot_at, active_watchers, new_watchers, churned_watchers, reactivated_watchers)
    VALUES ('2027-01-13', 1799840000, 0, 0, 0, 0), ('2027-01-14', 1799926400, 0, 0, 0, 0);
  `);
  return fixture;
}
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
import {
  mockD1 as baseMockD1,
  type MockD1Database,
  type MockPreparedStatement,
} from "@shared/test-utils/mock-d1";
import {
  handleTelegramPulse,
  publishTelegramPulseSnapshot,
  publishTelegramPulseSnapshotWithOutcome,
} from "../telegram-pulse";

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily WHERE day = ?", rows: [], first: null },
    { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [], first: null },
    { match: "FROM telegram_adoption_daily", rows: [] },
    { match: "FROM telegram_usage_daily", rows: [], first: null },
    { match: "FROM telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT INTO telegram_adoption_retention_daily", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  ], options);
}

describe("handleTelegramPulse", () => {
  it("serves a fresh materialized pulse snapshot without live aggregate reads", async () => {
    const cachedPulse = {
      activeWatchers: 8,
      coinSubscriptions: 13,
      explicitCoinSubscriptions: 10,
      presetImpliedCoinSubscriptions: 3,
      activePresetFollowers: 2,
      newWatchersToday: 1,
      churnedWatchersToday: 0,
      reactivatedWatchersToday: 0,
      historySource: "snapshot",
      topCoins: ["USDC"],
      pendingDeliveries: 3,
      miniAppSessionsToday: 4,
      miniAppMutationsToday: 2,
      updatedAt: Math.floor(Date.now() / 1000),
      updatedEverySeconds: 300,
      watcherHistory: [
        {
          date: "2026-04-01",
          timestamp: 1_775_001_600_000,
          newWatchers: 1,
          activeWatchers: 8,
          churnedWatchers: 2,
          reactivatedWatchers: 0,
        },
      ],
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify(cachedPulse),
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
    ]);

    const response = await handleTelegramPulse(db);
    expect(await readJsonResponse(response, 200)).toEqual({
      ...cachedPulse,
      newWatchersToday: null,
      pendingDeliveries: null,
      miniAppSessionsToday: null,
      miniAppMutationsToday: null,
      watcherHistory: [
        {
          ...cachedPulse.watcherHistory[0],
          newWatchers: null,
          churnedWatchers: null,
        },
      ],
      currentSnapshotAt: cachedPulse.updatedAt,
      lifecycleHistoryUpdatedAt: null,
      lifecycleHistoryEverySeconds: 900,
      quality: { status: "unknown", unavailableFields: [] },
      privacy: {
        exactActiveWatchers: true,
        lowCardinalityThreshold: 5,
        suppressedFields: [
          "miniAppMutationsToday",
          "miniAppSessionsToday",
          "newWatchersToday",
          "pendingDeliveries",
          "watcherHistory.churnedWatchers",
          "watcherHistory.newWatchers",
        ],
      },
    });
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(false);
  });

  it("rejects malformed cached pulse payloads and rebuilds a safe response", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "telegram:pulse:snapshot",
            value: JSON.stringify({
              activeWatchers: 1,
              coinSubscriptions: 1,
              updatedAt: Math.floor(Date.now() / 1000),
              updatedEverySeconds: 300,
              watcherHistory: [],
            }),
            updated_at: Math.floor(Date.now() / 1000),
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ active_watchers: 9, new_watchers: 0, explicit_coin_follows: 12, active_preset_followers: 0, active_dews_opt_ins: 9, active_depeg_opt_ins: 9, active_safety_opt_ins: 0, active_launch_opt_ins: 0, active_all_types_opt_ins: 0, quiet_hours_enabled_chats: 0 }),
        rows: [],
      },
      {
        match: "ORDER BY day DESC",
        first: null,
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "ORDER BY day ASC",
        rows: [],
      },
      {
        match: "GROUP BY day",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [{ stablecoin_id: "usdc-circle", subscribers: 12 }],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await readJsonResponse(response, 200)) as { activeWatchers: number; topCoins: string[]; quality: { status: string } };

    expect(body.activeWatchers).toBe(9);
    expect(body.topCoins).toEqual(["USDC"]);
    expect(body.quality.status).toBe("complete");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM telegram_subscribers s"))).toBe(true);
  });

  it("suppresses low-cardinality Mini App usage counts but exposes abuse-health counts", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 3,
          mini_app_mutations: 4,
          mini_app_denied: 2,
          mini_app_replay_claimed: 1,
        },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      miniAppSessionsToday: number | null;
      miniAppMutationsToday: number | null;
      miniAppDeniedToday: number | null;
      miniAppReplayClaimsToday: number | null;
      privacy: { suppressedFields: string[] };
    };

    expect(body.miniAppSessionsToday).toBeNull();
    expect(body.miniAppMutationsToday).toBeNull();
    expect(body.miniAppDeniedToday).toBe(2);
    expect(body.miniAppReplayClaimsToday).toBe(1);
    expect(body.privacy.suppressedFields).toEqual([
      "miniAppMutationsToday",
      "miniAppSessionsToday",
    ]);
  });

  it("reports unavailable pending deliveries through quality instead of privacy suppression", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        throwError: new Error("pending table unavailable"),
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 0,
          mini_app_mutations: 0,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);

    const response = await handleTelegramPulse(db);
    const body = (await response.json()) as {
      pendingDeliveries: number | null;
      quality: { status: string; unavailableFields: string[] };
      privacy: { suppressedFields: string[] };
    };

    expect(body.pendingDeliveries).toBeNull();
    expect(body.quality).toEqual({
      status: "partial",
      unavailableFields: ["pendingDeliveries"],
    });
    expect(body.privacy.suppressedFields).not.toContain("pendingDeliveries");
  });

  it("publishes only completed snapshot days as lifecycle history", async () => {
    const nowSec = Math.floor(Date.parse("2026-05-13T12:00:00.000Z") / 1000);
    const db = mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [
          {
            day: "2026-05-12",
            snapshot_at: nowSec - 86_400,
            active_watchers: 500,
            new_watchers: 20,
            churned_watchers: 7,
            reactivated_watchers: 3,
          },
          {
            day: "2026-05-13",
            snapshot_at: nowSec,
            active_watchers: 519,
            new_watchers: 19,
            churned_watchers: 0,
            reactivated_watchers: 0,
          },
        ],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate({ active_watchers: 519 }),
        rows: [],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_pending_alerts", first: { pending_count: 0 }, rows: [] },
    ]);

    const pulse = await publishTelegramPulseSnapshot(db, nowSec);

    expect(pulse.historySource).toBe("snapshot");
    expect(pulse.watcherHistory.map((point) => point.date)).toEqual(["2026-05-12"]);
    expect(db.getHistory().some((entry) => entry.sql.includes("GROUP BY day"))).toBe(false);
  });


});

describe("publishTelegramPulseSnapshot", () => {
  function observePulseReads(sqlite: Parameters<typeof createSqliteD1>[0]) {
    const observed = { sql: [] as string[], pendingUnavailable: false };
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...values) => {
        observed.sql.push(sql);
        return Reflect.apply(all, statement, values);
      });
      vi.spyOn(statement, "get").mockImplementation((...values) => {
        observed.sql.push(sql);
        if (observed.pendingUnavailable && sql.includes("FROM telegram_pending_alerts")) {
          throw new Error("pending table unavailable");
        }
        return Reflect.apply(get, statement, values);
      });
      return statement;
    });
    return observed;
  }

  function expectHeavyReads(sql: string[]) {
    expect(sql).toEqual(expect.arrayContaining([
      expect.stringContaining("GROUP BY stablecoin_id"),
      expect.stringContaining("WHERE day >= ? AND day < ?"),
      expect.stringContaining("FROM telegram_usage_daily"),
      expect.stringContaining("stage = 'first_mutation' AND outcome = 'success'"),
    ]));
  }

  it.each([300, 301])("serves cache through age 300, rebuilding at age %i", async (age) => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue((now - age) * 1000);
    const { db, sqlite } = persistedPulseDb();
    await publishTelegramPulseSnapshot(db, now - age);
    clock.mockReturnValue(now * 1000);
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_launch) VALUES ('new', ?, ?, 1)").run(now, now);
    const body = await readJsonResponse(await handleTelegramPulse(db), 200);
    expect(body).toMatchObject({ activeWatchers: age === 300 ? 0 : 1 });
  });

  it.each([899, 900])("reuses heavy sections strictly below 900 seconds (age %i)", async (age) => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    await publishTelegramPulseSnapshot(db, now - age);
    const outcome = await publishTelegramPulseSnapshotWithOutcome(db, now);
    expect(outcome.heavySectionsRecomputed).toBe(age === 900);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'telegram:pulse:heavy-sections-updated-at'").get())
      .toEqual({ value: String(age === 900 ? now : now - age) });
  });

  it.each(["legacy", "unknown"] as const)("rebuilds %s-quality cached heavy sections within the reuse window", async (quality) => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    const initial = await publishTelegramPulseSnapshotWithOutcome(db, now);
    expect(initial.pulse.quality.status).toBe("complete");
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'telegram:pulse:snapshot'").run(
      JSON.stringify({
        ...initial.pulse,
        quality: quality === "legacy" ? undefined : { status: "unknown", unavailableFields: [] },
      }),
    );
    const reads = observePulseReads(sqlite);
    const observedDb = createSqliteD1(sqlite);

    const recovered = await publishTelegramPulseSnapshotWithOutcome(observedDb, now + 899);

    expect(recovered.heavySectionsRecomputed).toBe(true);
    expectHeavyReads(reads.sql);
    expect(recovered.pulse.quality).toEqual({ status: "complete", unavailableFields: [] });
    expect(recovered.status).toBe("ok");
  });

  it("prefers unavailable rebuilt metrics over unknown cached quality", async () => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    const initial = await publishTelegramPulseSnapshotWithOutcome(db, now);
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'telegram:pulse:snapshot'").run(
      JSON.stringify({
        ...initial.pulse,
        quality: { status: "unknown", unavailableFields: ["topCoins"] },
      }),
    );
    let injected = false;
    const failingDb = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("GROUP BY stablecoin_id")) {
        injected = true;
        throw new Error("top coins unavailable");
      }
    } });

    const rebuilt = await publishTelegramPulseSnapshotWithOutcome(failingDb, now + 899);

    expect(injected).toBe(true);
    expect(rebuilt.heavySectionsRecomputed).toBe(true);
    expect(rebuilt.pulse.quality).toEqual({ status: "partial", unavailableFields: ["topCoins"] });
    expect(rebuilt.status).toBe("degraded");
  });

  it("does not launder unknown heavy-section provenance through pending-count failure and recovery", async () => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    const initial = await publishTelegramPulseSnapshotWithOutcome(db, now);
    sqlite.prepare("UPDATE cache SET value = ? WHERE key = 'telegram:pulse:snapshot'").run(
      JSON.stringify({ ...initial.pulse, quality: undefined }),
    );
    const reads = observePulseReads(sqlite);
    const observedDb = createSqliteD1(sqlite);
    reads.pendingUnavailable = true;

    const failedPending = await publishTelegramPulseSnapshotWithOutcome(observedDb, now + 300);

    expect(failedPending.heavySectionsRecomputed).toBe(true);
    expectHeavyReads(reads.sql);
    expect(failedPending.pulse.pendingDeliveries).toBeNull();
    expect(failedPending.pulse.quality).toEqual({
      status: "partial",
      unavailableFields: ["pendingDeliveries"],
    });
    expect(failedPending.status).toBe("degraded");
    const rebuiltReads = [...reads.sql];
    reads.sql.length = 0;
    reads.pendingUnavailable = false;

    const recovered = await publishTelegramPulseSnapshotWithOutcome(observedDb, now + 600);

    expect(recovered.heavySectionsRecomputed).toBe(false);
    expect(recovered.pulse.quality).toEqual({ status: "complete", unavailableFields: [] });
    expect(recovered.status).toBe("ok");
    expectHeavyReads(rebuiltReads);
    expect(reads.sql.some((sql) => sql.includes("FROM telegram_pending_alerts"))).toBe(true);
    expect(reads.sql.some((sql) => sql.includes("GROUP BY stablecoin_id"))).toBe(false);
    expect(reads.sql.some((sql) => sql.includes("WHERE day >= ? AND day < ?"))).toBe(false);
    expect(reads.sql.some((sql) => sql.includes("FROM telegram_usage_daily"))).toBe(false);
    expect(reads.sql.some((sql) => sql.includes("stage = 'first_mutation' AND outcome = 'success'"))).toBe(false);
  });

  it("preserves unavailable heavy metrics on reuse and clears quality after recovery", async () => {
    const now = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    let injected = false;
    const failingDb = createSqliteD1(sqlite, { onAll(sql) {
      if (sql.includes("GROUP BY stablecoin_id")) {
        injected = true;
        throw new Error("top coins unavailable");
      }
    } });
    const failed = await publishTelegramPulseSnapshotWithOutcome(failingDb, now);
    expect(injected).toBe(true);
    expect(failed.status).toBe("degraded");
    expect(failed.pulse.quality).toEqual({ status: "partial", unavailableFields: ["topCoins"] });
    expect(failed.pulse.privacy.suppressedFields).not.toContain("topCoins");
    const reused = await publishTelegramPulseSnapshotWithOutcome(db, now + 899);
    expect(reused.heavySectionsRecomputed).toBe(false);
    expect(reused.pulse.quality).toEqual({ status: "partial", unavailableFields: ["topCoins"] });
    const recovered = await publishTelegramPulseSnapshotWithOutcome(db, now + 900);
    expect(recovered.heavySectionsRecomputed).toBe(true);
    expect(recovered.status).toBe("ok");
    expect(recovered.pulse.quality).toEqual({ status: "complete", unavailableFields: [] });
  });
});

describe("publishTelegramPulseSnapshotWithOutcome", () => {
  const PULSE_SNAPSHOT_KEY = "telegram:pulse:snapshot";
  const HEAVY_MARKER_KEY = "telegram:pulse:heavy-sections-updated-at";

  /** Fail only cache writes for one key so publication ordering stays observable. */
  function failCacheWritesForKey(inner: MockD1Database, failKey: string): MockD1Database {
    return {
      ...inner,
      prepare: (sql: string) => {
        const statement = inner.prepare(sql) as MockPreparedStatement;
        if (!sql.includes("INTO cache")) return statement;
        return {
          ...statement,
          bind: (...binds: unknown[]) => {
            const bound = statement.bind(...binds) as MockPreparedStatement;
            if (binds[0] !== failKey) return bound;
            return {
              ...bound,
              run: async () => {
                throw new Error(`simulated D1 cache write failure for ${failKey}`);
              },
            } as unknown as MockPreparedStatement;
          },
        } as unknown as MockPreparedStatement;
      },
    } as unknown as MockD1Database;
  }

  function buildRebuildSourceDb(): MockD1Database {
    return mockD1([
      {
        match: "FROM telegram_watcher_lifecycle_daily",
        rows: [],
      },
      {
        match: "FROM telegram_subscribers s",
        first: pulseAggregate(),
        rows: [],
      },
      {
        match: "FROM telegram_preset_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_subscriptions",
        rows: [],
      },
      {
        match: "FROM telegram_pending_alerts",
        first: { pending_count: 0 },
        rows: [],
      },
      {
        match: "FROM telegram_usage_daily",
        first: {
          mini_app_sessions: 0,
          mini_app_mutations: 0,
          mini_app_denied: 0,
          mini_app_replay_claimed: 0,
        },
        rows: [],
      },
    ]);
  }

  it("reports a failed snapshot write and does not advance the heavy-section marker", async () => {
    const inner = buildRebuildSourceDb();
    const db = failCacheWritesForKey(inner, PULSE_SNAPSHOT_KEY);

    const outcome = await publishTelegramPulseSnapshotWithOutcome(db);

    expect(outcome.status).toBe("error");
    expect(outcome.snapshotPublished).toBe(false);
    expect(outcome.heavySectionsRecomputed).toBe(true);
    expect(outcome.heavyMarkerAdvanced).toBe(false);
    expect(outcome.error).toContain("simulated D1 cache write failure");
    expect(outcome.pulse.activeWatchers).toBe(12);

    const markerWrites = inner.getHistory().filter(
      (entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === HEAVY_MARKER_KEY,
    );
    expect(markerWrites).toEqual([]);
  });

  it("publishes the snapshot but degrades when the heavy-marker write fails", async () => {
    const inner = buildRebuildSourceDb();
    const db = failCacheWritesForKey(inner, HEAVY_MARKER_KEY);

    const outcome = await publishTelegramPulseSnapshotWithOutcome(db);

    expect(outcome.status).toBe("degraded");
    expect(outcome.snapshotPublished).toBe(true);
    expect(outcome.heavySectionsRecomputed).toBe(true);
    expect(outcome.heavyMarkerAdvanced).toBe(false);
    expect(outcome.error).toContain("simulated D1 cache write failure");

    const snapshotWrites = inner.getHistory().filter(
      (entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === PULSE_SNAPSHOT_KEY,
    );
    expect(snapshotWrites).toHaveLength(1);
  });

  it("degrades a skipped publication when the retained legacy pulse lacks quality", async () => {
    const newerAt = 1_800_000_000;
    const { db, sqlite } = persistedPulseDb();
    const legacyPulse = { ...buildCachedPulse(newerAt), quality: undefined };
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      PULSE_SNAPSHOT_KEY,
      JSON.stringify(legacyPulse),
      newerAt,
    );

    const outcome = await publishTelegramPulseSnapshotWithOutcome(db, newerAt - 60);

    expect(outcome.snapshotPublished).toBe(false);
    expect(outcome.staleWriteSkipped).toBe(true);
    expect(outcome.pulse.quality).toEqual({ status: "unknown", unavailableFields: [] });
    expect(outcome.status).toBe("degraded");
  });

  it("does not let an older pulse generation replace a newer publication", async () => {
    const newerAt = Math.floor(Date.parse("2027-01-15T12:00:00.000Z") / 1000);
    const { db, sqlite } = persistedPulseDb();

    const newer = await publishTelegramPulseSnapshotWithOutcome(db, newerAt);
    const older = await publishTelegramPulseSnapshotWithOutcome(db, newerAt - 60);
    const stored = sqlite.prepare(
      "SELECT value, updated_at FROM cache WHERE key = 'telegram:pulse:snapshot'",
    ).get() as { value: string; updated_at: number };

    expect(newer.snapshotPublished).toBe(true);
    expect(older.status).toBe("ok");
    expect(older.snapshotPublished).toBe(false);
    expect(older.staleWriteSkipped).toBe(true);
    expect(older.pulse.updatedAt).toBe(newerAt);
    expect(stored.updated_at).toBe(newerAt);
    expect(JSON.parse(stored.value)).toMatchObject({ updatedAt: newerAt });
  });
});
