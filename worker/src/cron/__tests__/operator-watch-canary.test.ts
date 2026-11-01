import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { ACTIVE_CANARY_CHECK_IDS } from "../../lib/canary-checks";
import { loadCanaryOperatorWatch } from "../operator-watch-canary";

const NOW = 1_750_000_000;
const [ERROR_ID, FAILED_ID, HEALTHY_ID, LEGACY_ID] = ACTIVE_CANARY_CHECK_IDS;

function unreadableDb(): D1Database {
  return {
    prepare: () => {
      throw new Error("worker_canary_runs unavailable");
    },
  } as unknown as D1Database;
}

/** Persist one fresh row per active check, then override the cases under test. */
function seedCanaryChecks() {
  const { db, sqlite } = createLatestSchemaSqlite();
  const insert = sqlite.prepare(`INSERT INTO worker_canary_runs
    (id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode)
    VALUES (?, ?, ?, 'ok', 'info', ?, 1, ?, NULL, 'status')`);
  for (const checkId of ACTIVE_CANARY_CHECK_IDS) {
    insert.run(`canary:${checkId}:${NOW}`, checkId, `${checkId}:${NOW}`, NOW,
      JSON.stringify({ executionStatus: "completed" }));
  }
  const update = sqlite.prepare(
    "UPDATE worker_canary_runs SET status = ?, severity = ?, metadata_json = ?, error = ? WHERE check_id = ?",
  );
  update.run("error", "error", JSON.stringify({ executionStatus: "completed" }), "e".repeat(800), ERROR_ID);
  update.run("error", "error",
    JSON.stringify({ executionStatus: "failed", executionFailureReason: "canary-source-unavailable" }),
    "D1 read failed", FAILED_ID);
  update.run("ok", "info", "{}", null, LEGACY_ID);
  return { db, sqlite };
}

describe("loadCanaryOperatorWatch", () => {
  it.each([undefined, "off", "shadow"] as const)(
    "keeps a disabled canary unknown instead of reporting recovery (%s)",
    async (mode) => {
      // A disabled canary evaluates nothing: prior findings must hold their
      // state rather than being reported as recovered (R2).
      expect(await loadCanaryOperatorWatch(unreadableDb(), NOW, mode)).toEqual({
        conditions: [], unknown: true,
      });
    },
  );
  it("keeps an unreadable canary status unknown", async () => {
    expect(await loadCanaryOperatorWatch(unreadableDb(), NOW, "status")).toEqual({
      conditions: [], unknown: true,
    });
  });
  it("raises only a completed error finding and holds failed or unknown measurements", async () => {
    const { db, sqlite } = seedCanaryChecks();
    try {
      const evidence = await loadCanaryOperatorWatch(db, NOW + 60, "status");
      expect(evidence.unknown).toBe(false);
      expect(evidence.conditions.find((condition) => condition.id === "cohort")).toBeUndefined();
      expect(evidence.conditions.find((condition) => condition.id === ERROR_ID)).toMatchObject({ active: true });
      expect(evidence.conditions.find((condition) => condition.id === FAILED_ID)).toEqual({
        id: FAILED_ID, active: false, unknown: true,
      });
      expect(evidence.conditions.find((condition) => condition.id === LEGACY_ID)).toEqual({
        id: LEGACY_ID, active: false, unknown: true,
      });
      expect(evidence.conditions.find((condition) => condition.id === HEALTHY_ID)).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
  it("keeps a whole missing cohort visible instead of overflowing the section line", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      const cohort = (await loadCanaryOperatorWatch(db, NOW, "status"))
        .conditions.find((condition) => condition.id === "cohort");
      expect(cohort?.active).toBe(true);
      expect(cohort?.label?.startsWith("missing checks:")).toBe(true);
      expect((cohort?.label ?? "").length).toBeLessThanOrEqual(83);
    } finally {
      sqlite.close();
    }
  });
  it("keeps the check id and truncates an over-long error detail", async () => {
    const { db, sqlite } = seedCanaryChecks();
    try {
      const condition = (await loadCanaryOperatorWatch(db, NOW + 60, "status"))
        .conditions.find((entry) => entry.id === ERROR_ID);
      const label = condition?.label ?? "";
      // The section helper drops any label too long for its line budget, so the
      // id must survive truncation.
      expect(label.startsWith(ERROR_ID)).toBe(true);
      expect(label).toContain("...");
      expect(label.length).toBeLessThanOrEqual(100);
    } finally {
      sqlite.close();
    }
  });
});
