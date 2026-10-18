import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  CACHE_RETENTION_POLICIES, RETENTION_NON_APPEND_TABLES, retentionPolicyRegistry,
} from "@shared/lib/retention-policy";
import {
  RETENTION_DELETE_BATCH_LIMIT, RETENTION_DELETE_RUN_LIMIT,
  RETENTION_SMALL_DELETE_BATCH_LIMIT, RETENTION_SMALL_DELETE_RUN_LIMIT,
} from "../../../lib/bounded-prune";

const root = path.resolve(__dirname, "../../../../..");
const { sqlite } = createLatestSchemaSqlite();
afterAll(() => sqlite.close());
const registry = retentionPolicyRegistry({
  batchLimit: RETENTION_DELETE_BATCH_LIMIT, runLimit: RETENTION_DELETE_RUN_LIMIT,
  smallBatchLimit: RETENTION_SMALL_DELETE_BATCH_LIMIT, smallRunLimit: RETENTION_SMALL_DELETE_RUN_LIMIT,
}, { safetyScoreJournalSec: 120 * 86_400 });
const tables = readFileSync(path.join(root, "worker/migrations/EXPECTED_SCHEMA.txt"), "utf8")
  .split("\n").filter((line) => line.startsWith("table\t")).map((line) => line.split("\t")[1]);

describe("retention policy registry", () => {
  it("registers every append-only timestamped schema table exactly once, with explicit non-append exclusions", () => {
    const entries = registry.map((policy) => policy.table);
    expect(new Set(entries).size).toBe(entries.length);
    for (const table of tables) {
      const count = entries.filter((entry) => entry === table).length;
      const exclusion = RETENTION_NON_APPEND_TABLES[table];
      expect(count + (exclusion ? 1 : 0), table).toBe(1);
      if (exclusion) expect(exclusion.length, table).toBeGreaterThan(10);
    }
    for (const table of [...entries, ...Object.keys(RETENTION_NON_APPEND_TABLES)]) {
      expect(tables, table).toContain(table);
    }
  });

  it("uses real schema clocks and names an executable owner for every delegated window", () => {
    for (const policy of registry) {
      const columns = sqlite.prepare(`PRAGMA table_info(${policy.table})`).all().map((row) => row.name);
      expect(columns, policy.table).toContain(policy.timestampColumn);
      if (!policy.permanent && "execution" in policy) {
        expect(existsSync(path.join(root, policy.owner)), policy.table).toBe(true);
        expect(policy.windowSec.authority).toBe(policy.owner);
        expect(policy.predicate.authority).toBe(policy.owner);
        expect(policy.batchLimit.authority).toBe(policy.owner);
        expect(policy.runLimit.authority).toBe(policy.owner);
      } else if (!policy.permanent) {
        expect(policy.batchLimit, policy.table).toBeGreaterThan(0);
        expect(policy.runLimit, policy.table).toBeGreaterThanOrEqual(policy.batchLimit);
      }
    }
  });

  it("keeps permanent product histories but preserves existing yield and DEX age pruners", () => {
    for (const table of ["supply_history", "tape_events", "depeg_events"]) {
      expect(registry.find((policy) => policy.table === table)).toMatchObject({ permanent: true, windowSec: null });
    }
    for (const table of ["yield_source_decisions", "dex_liquidity_history", "yield_history"]) {
      expect(registry.find((policy) => policy.table === table)).toMatchObject({ permanent: false, execution: "owner" });
    }
  });

  it("has no remaining runtime reader or writer of a retired cache version", () => {
    const retired = CACHE_RETENTION_POLICIES.filter((policy) => policy.windowSec == null);
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "test-helpers") continue;
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".test")) files.push(name);
      }
    };
    visit(path.join(root, "worker/src"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const policy of retired) expect(source.includes(policy.key), `${file}: ${policy.key}`).toBe(false);
    }
  });

  it("adds a distinct logical-slot-clock prune index rather than reusing the actual-start index", () => {
    expect(sqlite.prepare("PRAGMA index_info(idx_cron_slot_executions_slot_started_at_prune)").all()
      .map((row) => row.name)).toEqual(["slot_started_at"]);
    expect(sqlite.prepare("PRAGMA index_info(idx_cron_slot_executions_slot_started_at)").all()
      .map((row) => row.name)).toEqual(["slot_key", "started_at"]);
  });
});
