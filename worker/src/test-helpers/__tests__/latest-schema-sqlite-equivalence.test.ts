import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, URL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

/**
 * Equivalence gate for the latest-schema harness (PLAN.md:175). However the
 * harness materializes a fixture — replaying `worker/migrations` or restoring a
 * serialized template — each fixture must be indistinguishable from a fresh
 * migration replay and independent of every other fixture. Assertions here
 * compare against an independent replay or against a sibling fixture, never
 * against the harness's own bookkeeping, so they hold for either strategy.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
const HELPER_MODULE = path.resolve(__dirname, "../../../../shared/test-utils/latest-schema-sqlite.ts");

/** Independent migration replay: the truth every fixture is compared against. */
function replayMigrations(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
  return sqlite;
}

type DatabaseState = {
  objects: Array<{ type: string; name: string; table: string; sql: string }>;
  rowCounts: Record<string, number>;
  pragmas: Record<string, string>;
};

function describeDatabase(sqlite: DatabaseSync): DatabaseState {
  const objects = sqlite
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => ({ type: String(row.type), name: String(row.name), table: String(row.tbl_name), sql: String(row.sql) }));
  const rowCounts: Record<string, number> = {};
  for (const object of objects) {
    if (object.type !== "table") continue;
    rowCounts[object.name] = Number(sqlite.prepare(`SELECT count(*) AS count FROM "${object.name}"`).get()?.count);
  }
  const pragmas: Record<string, string> = {};
  for (const pragma of ["user_version", "page_size", "encoding", "foreign_keys", "integrity_check"]) {
    pragmas[pragma] = String(Object.values(sqlite.prepare(`PRAGMA ${pragma}`).get() ?? {})[0]);
  }
  return { objects, rowCounts, pragmas };
}

function cacheKeys(sqlite: DatabaseSync): string[] {
  return sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => String(row.key));
}

function insertCacheKey(sqlite: DatabaseSync, key: string): void {
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, 'value', 1)").run(key);
}

/**
 * Opens a fixture through the real helper on a worker thread. Vitest's
 * `worker-threads` project and any thread pool give each thread its own module
 * instance; this proves the harness carries no cross-thread shared state.
 */
async function cacheKeysFromWorkerThread(key: string): Promise<string[]> {
  const workerData = { helper: pathToFileURL(HELPER_MODULE).href, key };
  // The thread runs from a data: URL, so the helper is an absolute file URL
  // reachable only via `workerData`, hence the runtime import. tsx is loaded
  // as the thread's own loader (`--import tsx`, the same path every
  // `node --import tsx` script in this repo uses) so the helper's relative
  // TypeScript imports resolve on every supported Node line.
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    const { createLatestSchemaSqlite } = await import(workerData.helper);
    const { sqlite } = createLatestSchemaSqlite();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, 'value', 1)").run(workerData.key);
    parentPort.postMessage(sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => String(row.key)));
    sqlite.close();
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData,
    execArgv: ["--import", "tsx"],
  });
  try {
    return await new Promise<string[]>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`worker exited with ${code} before reporting`)));
    });
  } finally {
    await worker.terminate();
  }
}

const reference = replayMigrations();
const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => fixtures.closeAll());
afterAll(() => reference.close());

describe("latest-schema fixture equivalence", () => {
  it("matches an independent worker/migrations replay in schema, seeded rows and integrity", () => {
    const { sqlite } = fixtures.open();

    expect(describeDatabase(sqlite)).toEqual(describeDatabase(reference));
  });

  it("enforces the migrated foreign-key, check, not-null and uniqueness constraints", () => {
    const { sqlite } = fixtures.open();
    const orphan = "INSERT INTO blacklist_amount_repair_queue (event_id, status, reason, created_at, updated_at)";

    expect(() => sqlite.exec(`${orphan} VALUES ('missing', 'pending', 'r', 1, 1)`)).toThrow(/FOREIGN KEY/);
    expect(() => sqlite.exec(`${orphan} VALUES ('missing', 'bogus', 'r', 1, 1)`)).toThrow(/CHECK/);
    expect(() => sqlite.exec("INSERT INTO cache (key, value, updated_at) VALUES ('k', NULL, 1)")).toThrow(/NOT NULL/);
    insertCacheKey(sqlite, "k");
    expect(() => insertCacheKey(sqlite, "k")).toThrow(/UNIQUE/);
  });

  it.each([false, true])("keeps global DEX history reads and date deletes indexed (ANALYZE=%s)", (analyze) => {
    const { sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, snapshot_date, total_tvl_usd, liquidity_score) VALUES (?, ?, 100, 73)");
    for (let coin = 0; coin < 32; coin += 1) {
      for (let day = 0; day < 60; day += 1) insert.run(`coin-${coin}`, day * 86400);
    }
    if (analyze) sqlite.exec("ANALYZE");
    const read = "SELECT stablecoin_id, snapshot_date, liquidity_score FROM dex_liquidity_history WHERE snapshot_date >= ? ORDER BY snapshot_date ASC";
    const prune = "DELETE FROM dex_liquidity_history WHERE snapshot_date < ?";
    const replace = "DELETE FROM dex_liquidity_history WHERE snapshot_date = ?";
    for (const query of [read, prune, replace]) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(59 * 86400);
      expect(plan.map((row) => String(row.detail)).join("\n")).toMatch(/SEARCH dex_liquidity_history USING (?:COVERING )?INDEX idx_dex_hist_snapshot_date/);
    }
    expect(sqlite.prepare(read).all(59 * 86400).sort((a, b) => String(a.stablecoin_id).localeCompare(String(b.stablecoin_id))))
      .toEqual(Array.from({ length: 32 }, (_, coin) => ({
        stablecoin_id: `coin-${coin}`, snapshot_date: 59 * 86400, liquidity_score: 73,
      })).sort((a, b) => a.stablecoin_id.localeCompare(b.stablecoin_id)));
    expect(sqlite.prepare(prune).run(86400).changes).toBe(32);
    expect(sqlite.prepare("SELECT DISTINCT snapshot_date FROM dex_liquidity_history WHERE snapshot_date <= ?").all(86400))
      .toEqual([{ snapshot_date: 86400 }]);
    expect(sqlite.prepare(replace).run(59 * 86400).changes).toBe(32);
    expect(sqlite.prepare(read).all(59 * 86400)).toEqual([]);

    const indexes = sqlite.prepare("PRAGMA index_list(dex_liquidity_history)").all();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_dex_hist_snapshot_date", unique: 0 }),
      expect.objectContaining({ name: "idx_dex_hist_coin_date", unique: 0 }),
      expect.objectContaining({ name: "idx_dex_hist_coin_date_unique", unique: 1 }),
    ]));
    expect(() => insert.run("coin-0", 86400)).toThrow(/UNIQUE/);
    const expectedObjects = readFileSync(path.join(MIGRATIONS_DIR, "EXPECTED_SCHEMA.txt"), "utf8").split("\n");
    for (const name of ["idx_dex_hist_snapshot_date", "idx_dex_hist_coin_date", "idx_dex_hist_coin_date_unique", "idx_blacklist_events_chain_block"]) {
      expect(expectedObjects).toContain(`index\t${name}`);
      expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)).toEqual({ name });
    }
  });

  it.each([false, true])("retains unique access paths for the four queued duplicate indexes (ANALYZE=%s)", (analyze) => {
    const { sqlite } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_alert_source_events (
        source_event_id, status, detected_at, expires_at,
        event_payload, baseline_payload, target_plan_state, target_plan_generation
      ) VALUES ('event', 'planned', 1, 3, '{}', '{}', 'capturing', 1)
    `);
    const cases = [
      {
        table: "dex_liquidity_history", candidate: "idx_dex_hist_coin_date", origin: "c",
        columns: ["stablecoin_id", "snapshot_date"], value: "snapshot_date", expected: 2,
        predicate: "WHERE stablecoin_id = 'coin' AND snapshot_date >= 1 ORDER BY snapshot_date DESC",
        seed: "INSERT INTO dex_liquidity_history (stablecoin_id, snapshot_date, total_tvl_usd) VALUES ('coin', 2, 100)",
      },
      {
        table: "dex_liquidity_scoring_stages", candidate: "idx_dex_liquidity_scoring_stages_slot", origin: "u",
        columns: ["source_slot_started_at"], value: "source_slot_started_at", expected: 2,
        predicate: "WHERE source_slot_started_at >= 1 ORDER BY source_slot_started_at DESC",
        seed: "INSERT INTO dex_liquidity_scoring_stages (generation_id, schema_version, state, source_slot_started_at, sync_started_at, created_at) VALUES ('gen', 1, 'ready', 2, 2, 2)",
      },
      {
        table: "telegram_alert_planning_subscribers", candidate: "idx_taps_scan", origin: "pk",
        columns: ["source_event_id", "plan_generation", "chat_id"], value: "chat_id", expected: "b",
        predicate: "WHERE source_event_id = 'event' AND plan_generation = 1 AND chat_id > 'a' ORDER BY chat_id",
        seed: "INSERT INTO telegram_alert_planning_subscribers (source_event_id, plan_generation, chat_id, preference_generation, last_active_at, captured_at) VALUES ('event', 1, 'b', 1, 2, 2)",
      },
      {
        table: "yield_source_decisions", candidate: "idx_yield_source_decisions_generation", origin: "pk",
        columns: ["generation_id", "stablecoin_id"], value: "stablecoin_id", expected: "coin",
        predicate: "WHERE generation_id = 'gen' ORDER BY stablecoin_id",
        seed: "INSERT INTO yield_source_decisions (generation_id, stablecoin_id, selected_source_key, selected_confidence_tier, selected_data_source, selected_apy_30d, selected_reason, alternatives_json, created_at) VALUES ('gen', 'coin', 'source', 'tier', 'test', 1, 'selected', '[]', 2)",
      },
    ];
    for (const { table, candidate, origin, columns, value, expected, predicate, seed } of cases) {
      sqlite.exec(seed);
      if (analyze) sqlite.exec("ANALYZE");
      const indexes = sqlite.prepare(`PRAGMA index_list("${table}")`).all();
      // Queue admission must not silently contract today's fresh schema.
      expect(indexes).toContainEqual(expect.objectContaining({ name: candidate, unique: 0 }));
      const survivor = indexes.find((index) => index.unique === 1 && index.origin === origin
        && sqlite.prepare(`PRAGMA index_info("${index.name}")`).all().map((column) => String(column.name)).join(",") === columns.join(","));
      expect(survivor).toBeDefined();
      const query = `SELECT ${value} AS value FROM ${table}`;
      const retainedQuery = `${query} INDEXED BY "${survivor?.name}" ${predicate}`;
      const details = sqlite.prepare(`EXPLAIN QUERY PLAN ${retainedQuery}`).all().map((row) => String(row.detail)).join("\n");
      expect(details).toContain(`INDEX ${survivor?.name}`);
      expect(details).toMatch(/SEARCH /);
      expect(details).not.toMatch(/TEMP B-TREE/);
      expect(sqlite.prepare(retainedQuery).all()).toEqual([{ value: expected }]);
      expect(sqlite.prepare(`${query} ${predicate}`).all()).toEqual([{ value: expected }]);
      expect(() => sqlite.exec(seed)).toThrow(/UNIQUE/);
    }
  });
});

describe("latest-schema fixture rollback", () => {
  it("restores committed state after a failed transaction and stays writable", () => {
    const { sqlite } = fixtures.open();
    insertCacheKey(sqlite, "committed");

    sqlite.exec("BEGIN");
    insertCacheKey(sqlite, "in-flight");
    expect(() => insertCacheKey(sqlite, "committed")).toThrow(/UNIQUE/);
    sqlite.exec("ROLLBACK");
    insertCacheKey(sqlite, "after-rollback");

    expect(cacheKeys(sqlite)).toEqual(["after-rollback", "committed"]);
  });

  it("keeps a rolled-back fixture from leaving anything behind in later fixtures", () => {
    const aborted = fixtures.open();
    aborted.sqlite.exec("BEGIN");
    insertCacheKey(aborted.sqlite, "aborted");
    aborted.sqlite.exec("ROLLBACK");

    const later = fixtures.open();

    expect(cacheKeys(later.sqlite)).toEqual([]);
    expect(describeDatabase(later.sqlite)).toEqual(describeDatabase(reference));
  });
});

describe("latest-schema fixture fault containment", () => {
  it("gives a later fixture the full schema after an earlier one destroys its own", () => {
    const damaged = fixtures.open();
    damaged.sqlite.exec(`
      DROP TABLE cache;
      DROP TABLE blacklist_amount_repair_queue;
      DELETE FROM blacklist_sync_state;
      CREATE TABLE intruder (id INTEGER PRIMARY KEY);
    `);

    const fresh = fixtures.open();

    expect(describeDatabase(fresh.sqlite)).toEqual(describeDatabase(reference));
  });

  it("opens and commits a new fixture while another holds an exclusive transaction", () => {
    const holder = fixtures.open();
    holder.sqlite.exec("BEGIN EXCLUSIVE");
    insertCacheKey(holder.sqlite, "holder");

    const opened = fixtures.open();
    opened.sqlite.exec("BEGIN");
    insertCacheKey(opened.sqlite, "opened");
    opened.sqlite.exec("COMMIT");

    expect(cacheKeys(opened.sqlite)).toEqual(["opened"]);
  });
});

describe("latest-schema fixture isolation", () => {
  it("hides writes from fixtures opened before and after the writer", () => {
    const earlier = fixtures.open();
    const writer = fixtures.open();
    const insert = writer.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, 1)");
    // Well past the template's own page count, so the writer's database must own
    // resizeable storage rather than share the pages it started from.
    for (let index = 0; index < 4000; index += 1) insert.run(`key-${index}`, "payload".repeat(128));

    const later = fixtures.open();

    expect(Number(writer.sqlite.prepare("SELECT count(*) AS count FROM cache").get()?.count)).toBe(4000);
    expect(cacheKeys(earlier.sqlite)).toEqual([]);
    expect(cacheKeys(later.sqlite)).toEqual([]);
  });

  it("keeps a fixture opened on a worker thread independent of the main thread", async () => {
    const main = fixtures.open();
    insertCacheKey(main.sqlite, "main-thread");

    const threadKeys = await cacheKeysFromWorkerThread("worker-thread");

    expect(threadKeys).toEqual(["worker-thread"]);
    expect(cacheKeys(main.sqlite)).toEqual(["main-thread"]);
  });
});
