import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { CircuitRecord } from "../circuit-breaker";
import {
  getCircuitRecord,
  shouldAttemptFetch,
  recordOutcome,
  recoverBreakerOnNoCandidate,
  getCircuitStates,
  getCircuitRecordsForSources,
  listActiveCircuitSources,
  filterInactiveCircuitStates,
  mapCronStatusToCircuitOutcome,
  resetCircuitBreakerStateForTests,
} from "../circuit-breaker";
import { CIRCUIT_SOURCE } from "../constants";
import { CIRCUIT_OPEN_THRESHOLD, CIRCUIT_PROBE_INTERVAL_SEC } from "@shared/lib/ops-limits";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { countPublicImpactOpenCircuits, getCircuitImpactStatus } from "@shared/lib/public-health";

const fixtures = createLatestSchemaFixtureTracker();

function makeRecord(overrides: Partial<CircuitRecord> = {}): CircuitRecord {
  return {
    state: "closed",
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
    ...overrides,
  };
}

function mockDbWithCircuit(source: string, record: CircuitRecord | null) {
  const cacheRows = record
    ? [{ key: `circuit:${source}`, value: JSON.stringify(record), updated_at: 100 }]
    : [];
  return mockD1([{ match: "cache", rows: cacheRows }]);
}

function countCircuitRecordReads(
  db: { getHistory: () => Array<{ sql: string; binds: unknown[] }> },
  source: string,
): number {
  return db
    .getHistory()
    .filter((entry) =>
      entry.sql.includes("SELECT value, updated_at FROM cache WHERE key = ?") &&
      entry.binds[0] === `circuit:${source}`
    ).length;
}

function circuitCacheKeysTouched(db: { getHistory: () => Array<{ sql: string; binds: unknown[] }> }): string[] {
  return db
    .getHistory()
    .filter((entry) =>
      (
        entry.sql.includes("FROM cache WHERE key = ?") ||
        entry.sql.includes("INSERT INTO cache") ||
        entry.sql.includes("DELETE FROM cache WHERE key = ?")
      ) &&
      typeof entry.binds[0] === "string"
    )
    .map((entry) => String(entry.binds[0]));
}

describe("circuit-breaker", () => {
  beforeEach(() => {
    resetCircuitBreakerStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fixtures.closeAll();
  });

  describe("mapCronStatusToCircuitOutcome", () => {
    it("maps ok and undefined statuses to success", () => {
      expect(mapCronStatusToCircuitOutcome("ok")).toBe("success");
      expect(mapCronStatusToCircuitOutcome(undefined)).toBe("success");
    });

    it("maps degraded and skipped statuses to neutral", () => {
      expect(mapCronStatusToCircuitOutcome("degraded")).toBe("neutral");
      expect(mapCronStatusToCircuitOutcome("skipped_locked")).toBe("neutral");
      expect(mapCronStatusToCircuitOutcome("skipped_neutral")).toBe("neutral");
    });

    it("maps error to failure", () => {
      expect(mapCronStatusToCircuitOutcome("error")).toBe("failure");
    });
  });

  // --- getCircuitRecord ---

  describe("getCircuitRecord", () => {

    it("parses stored state correctly", async () => {
      const stored = makeRecord({
        state: "open",
        consecutiveFailures: 3,
        lastFailureAt: 1000,
        openedAt: 1000,
      });
      const db = mockDbWithCircuit("test-source", stored);
      const record = await getCircuitRecord(db, "test-source");
      expect(record.state).toBe("open");
      expect(record.consecutiveFailures).toBe(3);
      expect(record.lastFailureAt).toBe(1000);
      expect(record.openedAt).toBe(1000);
    });

    it("fails closed for malformed JSON instead of inventing a closed record", async () => {
      const db = mockD1([{
        match: "cache",
        rows: [{ key: "circuit:test", value: "not-json", updated_at: 100 }],
      }]);
      await expect(getCircuitRecord(db, "test")).rejects.toThrow("Invalid circuit record for test");
    });

    it.each(["consecutiveFailures", "lastFailureAt", "lastSuccessAt", "openedAt"])(
      "rejects persisted JSON overflow in %s",
      async (field) => {
        const stored = JSON.stringify({ ...makeRecord({ state: "open", consecutiveFailures: 3 }), [field]: "overflow" })
          .replace('"overflow"', "1e999");
        const db = mockD1([{
          match: "cache",
          rows: [{ key: "circuit:overflow", value: stored, updated_at: 100 }],
        }]);
        await expect(getCircuitRecord(db, "overflow")).rejects.toThrow("Invalid circuit record for overflow");
        expect(await getCircuitStates(db)).toEqual({});
      },
    );


    it("memoizes repeated reads briefly and returns defensive copies", async () => {
      const db = mockDbWithCircuit("memo-source", makeRecord({ state: "closed" }));
      const first = await getCircuitRecord(db, "memo-source");
      first.state = "open";

      const second = await getCircuitRecord(db, "memo-source");

      expect(second.state).toBe("closed");
      expect(countCircuitRecordReads(db, "memo-source")).toBe(1);
    });

    it("deduplicates concurrent reads for the same source", async () => {
      const db = mockDbWithCircuit("pending-source", makeRecord({ state: "closed" }));

      await Promise.all([
        getCircuitRecord(db, "pending-source"),
        getCircuitRecord(db, "pending-source"),
      ]);

      expect(countCircuitRecordReads(db, "pending-source")).toBe(1);
    });

    it("drops memoized reads when isolate-local state is reset", async () => {
      const db = mockDbWithCircuit("reset-source", makeRecord({ state: "closed" }));

      await getCircuitRecord(db, "reset-source");
      resetCircuitBreakerStateForTests();
      await getCircuitRecord(db, "reset-source");

      expect(countCircuitRecordReads(db, "reset-source")).toBe(2);
    });

    it("refreshes backing state exactly when the memo expires", async () => {
      const { db, sqlite } = fixtures.open();
      expect(await getCircuitRecord(db, "expiry")).toEqual(makeRecord());
      const changed = makeRecord({ state: "open", consecutiveFailures: 3 });
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("circuit:expiry", JSON.stringify(changed), 100);
      vi.advanceTimersByTime(4_999);
      expect(await getCircuitRecord(db, "expiry")).toEqual(makeRecord());
      vi.advanceTimersByTime(1);
      expect(await getCircuitRecord(db, "expiry")).toEqual(changed);
    });

    it("does not let a pre-write deferred read repopulate stale memo state", async () => {
      const { db } = fixtures.open();
      await getCircuitRecord(db, "racing");
      // Outcome captures the current memo before a separate expired read begins.
      const write = recordOutcome(db, "racing", false);
      vi.advanceTimersByTime(5_000);
      const originalPrepare = db.prepare.bind(db);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.startsWith("SELECT value, updated_at")) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = (...args: unknown[]) => {
          const bound = bind(...args);
          const first = bound.first.bind(bound);
          bound.first = (async () => {
            const old = await first();
            await gate;
            return old;
          }) as typeof bound.first;
          return bound;
        };
        return statement;
      });
      const oldRead = getCircuitRecord(db, "racing");
      const outcome = await write;
      release();
      expect(await oldRead).toEqual(makeRecord());
      expect(await getCircuitRecord(db, "racing")).toEqual(outcome.after);
      expect(outcome.after.consecutiveFailures).toBe(1);
    });

    it("isolates memo records for the same source in different databases", async () => {
      const first = fixtures.open();
      const second = fixtures.open();
      await recordOutcome(first.db, "shared-source", false);
      expect((await getCircuitRecord(first.db, "shared-source")).consecutiveFailures).toBe(1);
      expect(await getCircuitRecord(second.db, "shared-source")).toEqual(makeRecord());
    });
  });

  // --- shouldAttemptFetch ---

  describe("shouldAttemptFetch", () => {
    it("allows fetch when circuit is closed", async () => {
      const db = mockDbWithCircuit("src", makeRecord({ state: "closed" }));
      expect(await shouldAttemptFetch(db, "src")).toBe(true);
    });

    it("allows fetch when no record exists (default closed)", async () => {
      const db = mockD1([{ match: "cache", rows: [] }]);
      expect(await shouldAttemptFetch(db, "unknown")).toBe(true);
    });

    it("blocks fetch when circuit is open and probe interval not elapsed", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockDbWithCircuit("src", makeRecord({
        state: "open",
        openedAt: now - 100, // only 100s ago, probe needs 1800s
      }));
      expect(await shouldAttemptFetch(db, "src")).toBe(false);
    });

    it("allows probe after 30 min (transitions open → half-open)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockDbWithCircuit("src", makeRecord({
        state: "open",
        openedAt: now - 1801, // 30min + 1s ago
      }));
      expect(await shouldAttemptFetch(db, "src")).toBe(true);
    });

    it("invalidates cached state after an open to half-open transition", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockDbWithCircuit("half-open-memo", makeRecord({
        state: "open",
        openedAt: now - 1801,
      }));

      expect(await shouldAttemptFetch(db, "half-open-memo")).toBe(true);
      await getCircuitRecord(db, "half-open-memo");

      expect(countCircuitRecordReads(db, "half-open-memo")).toBe(2);
    });

    it("allows probe when in half-open state", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockDbWithCircuit("src", makeRecord({ state: "half-open", lastFailureAt: now - 60 }));
      expect(await shouldAttemptFetch(db, "src")).toBe(true);
    });

    it("reverts to open when a half-open probe never recorded an outcome", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = mockDbWithCircuit("src", makeRecord({
        state: "half-open",
        // Two probe intervals after the failure that opened the circuit: the
        // admitted probe aborted before recording an outcome.
        lastFailureAt: now - 3601,
        openedAt: now - 3601,
      }));
      expect(await shouldAttemptFetch(db, "src")).toBe(false);
    });
  });

  // --- recordOutcome — success ---

  describe("recordOutcome — success", () => {
    it("resets consecutiveFailures to 0", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 2 });
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run("circuit:src", JSON.stringify(stored), 100);
      const expected = makeRecord({ lastSuccessAt: Math.floor(Date.now() / 1000) });
      expect(await recordOutcome(db, "src", true)).toEqual({ before: stored, after: expected });
      const row = sqlite.prepare("SELECT value FROM cache WHERE key = 'circuit:src'").get();
      expect(JSON.parse(String(row?.value))).toEqual(expected);
    });

    it("transitions half-open → closed", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", true);
      expect(outcome).toBeDefined();
      expect(outcome!.before.state).toBe("half-open");
      expect(outcome!.after).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
      });
    });

    it("transitions open → closed", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 3600 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", true);
      expect(outcome.after.state).toBe("closed");
    });


    it("stores only the authoritative circuit record cache row", async () => {
      const stored = makeRecord({ state: "closed" });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", true);

      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
        lastSuccessAt: Math.floor(Date.now() / 1000),
      });
      expect(circuitCacheKeysTouched(db)).toEqual(["circuit:src", "circuit:src"]);
    });

  });

  describe("malformed outcome repair", () => {
    it.each(["not-json", JSON.stringify({ state: "unknown" })])("denies admission then repairs success for %s", async (value) => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("circuit:dwellir-evm", value, 100);
      // Denial, not a throw: the predicate must not fail its caller's request.
      expect(await shouldAttemptFetch(db, "dwellir-evm")).toBe(false);
      await recordOutcome(db, "dwellir-evm", true);
      expect(await getCircuitRecord(db, "dwellir-evm")).toEqual(makeRecord({ lastSuccessAt: Math.floor(Date.now() / 1000) }));
      expect(await shouldAttemptFetch(db, "dwellir-evm")).toBe(true);
    });

    it("repairs a failure to an open circuit, without reopening admission", async () => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("circuit:dwellir-evm", "not-json", 100);
      const outcome = await recordOutcome(db, "dwellir-evm", false);
      expect(outcome.after).toMatchObject({
        state: "open",
        consecutiveFailures: CIRCUIT_OPEN_THRESHOLD + 1,
        lastFailureAt: Math.floor(Date.now() / 1000),
      });
      expect(await shouldAttemptFetch(db, "dwellir-evm")).toBe(false);
    });

    it("applies the same fail-closed repair to every source", async () => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("circuit:coingecko-prices", "not-json", 100);
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
      expect((await recordOutcome(db, "coingecko-prices", false)).after)
        .toMatchObject({ state: "open", consecutiveFailures: CIRCUIT_OPEN_THRESHOLD + 1 });
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
    });

    it("persists the repair on denial so the breaker can probe again", async () => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("circuit:coingecko-prices", "not-json", 100);
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
      const repaired = sqlite.prepare("SELECT value FROM cache WHERE key = 'circuit:coingecko-prices'").get() as { value: string };
      expect(JSON.parse(repaired.value)).toMatchObject({
        state: "open",
        consecutiveFailures: CIRCUIT_OPEN_THRESHOLD,
        openedAt: Math.floor(Date.now() / 1000),
      });
      vi.advanceTimersByTime((CIRCUIT_PROBE_INTERVAL_SEC + 1) * 1_000);
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(true);
    });

    it("still denies admission when the fail-closed repair cannot be persisted", async () => {
      const { db, sqlite } = fixtures.open();
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("circuit:coingecko-prices", "not-json", 100);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (sql.includes("INSERT INTO cache")) throw new Error("D1 unavailable");
        return prepare(sql);
      });
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
    });

    it("denies a future-dated open record and repairs it without erasing the outage", async () => {
      const { db, sqlite } = fixtures.open();
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "circuit:coingecko-prices",
        JSON.stringify(makeRecord({ state: "open", consecutiveFailures: 3, lastFailureAt: now - 60, openedAt: now - 60 })),
        now + 120,
      );
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
      expect((await recordOutcome(db, "coingecko-prices", false)).after).toMatchObject({
        state: "open",
        consecutiveFailures: CIRCUIT_OPEN_THRESHOLD + 1,
        lastFailureAt: now,
      });
      expect(await shouldAttemptFetch(db, "coingecko-prices")).toBe(false);
    });

    it("labels a future-dated row invalid instead of publishing its stored state", async () => {
      const { db, sqlite } = fixtures.open();
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "circuit:coingecko-prices",
        JSON.stringify(makeRecord({ state: "open", consecutiveFailures: 3, lastFailureAt: now - 60, openedAt: now - 60 })),
        now + 120,
      );
      const result = await getCircuitRecordsForSources(db, ["coingecko-prices"]);
      expect(result.records).toEqual({});
      expect(result.invalidSources).toEqual(["coingecko-prices"]);
    });
  });

  // --- recordOutcome — failure ---

  describe("recordOutcome — failure", () => {

    it("opens circuit at threshold (3 failures)", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 2 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", false);
      expect(outcome.after).toMatchObject({ state: "open", consecutiveFailures: 3 });
    });

    it("does not open circuit before threshold", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 1 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", false);
      expect(outcome.after).toMatchObject({ state: "closed", consecutiveFailures: 2 });
    });

    it("stays open on further failures after opening", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 100 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", false);
      expect(outcome.after).toMatchObject({ state: "open", consecutiveFailures: 6 });
    });

    it("half-open probe failure reopens circuit", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      const outcome = await recordOutcome(db, "src", false);
      expect(outcome.after).toMatchObject({ state: "open", consecutiveFailures: 4 });
    });
  });

  // --- getCircuitStates ---

  describe("getCircuitStates", () => {
    it("returns all circuit records", async () => {
      const db = mockD1([{
        match: "circuit",
        rows: [
          { key: "circuit:source-a", value: JSON.stringify(makeRecord({ state: "closed" })) },
          { key: "circuit:source-b", value: JSON.stringify(makeRecord({ state: "open", consecutiveFailures: 3 })) },
        ],
      }]);
      const states = await getCircuitStates(db);
      expect(Object.keys(states)).toHaveLength(2);
      expect(states["source-a"].state).toBe("closed");
      expect(states["source-b"].state).toBe("open");
      expect(states["source-b"].consecutiveFailures).toBe(3);
    });


    it("handles malformed JSON gracefully (skips bad entries)", async () => {
      const db = mockD1([{
        match: "circuit",
        rows: [
          { key: "circuit:good", value: JSON.stringify(makeRecord({ state: "closed" })) },
          { key: "circuit:bad", value: "not-json" },
        ],
      }]);
      const states = await getCircuitStates(db);
      expect(Object.keys(states)).toHaveLength(1);
      expect(states["good"].state).toBe("closed");
      expect(states["bad"]).toBeUndefined();
    });
  });

  describe("filterInactiveCircuitStates", () => {
    it("drops retired circuit cache rows that are not configured sources", () => {
      const states = filterInactiveCircuitStates({
        [CIRCUIT_SOURCE.DEXSCREENER_PRICES]: makeRecord({ state: "open", consecutiveFailures: 3 }),
        "pyth-prices": makeRecord({ state: "open", consecutiveFailures: 30 }),
        "geckoterminal-address-prices": makeRecord({ state: "open", consecutiveFailures: 13 }),
      });

      expect(states[CIRCUIT_SOURCE.DEXSCREENER_PRICES]?.state).toBe("open");
      expect(states["pyth-prices"]).toBeUndefined();
      expect(states["geckoterminal-address-prices"]).toBeUndefined();
    });
  });

  it("does not list retired provider circuits", () => {
    expect(listActiveCircuitSources()).not.toContain("pyth-prices");
    expect(listActiveCircuitSources()).not.toContain("redstone-prices");
  });

  it("excludes retained DefiLlama confirmation state from active public outages", () => {
    const legacy = "defillama-confirm";
    const circuits = {
      [legacy]: makeRecord({ state: "open", consecutiveFailures: 30 }),
      [CIRCUIT_SOURCE.DL_STABLECOINS]: makeRecord({ state: "open", consecutiveFailures: 3 }),
      [CIRCUIT_SOURCE.CG_PRICES]: makeRecord({ state: "open", consecutiveFailures: 3 }),
    };
    expect(listActiveCircuitSources()).not.toContain(legacy);
    expect(filterInactiveCircuitStates(circuits)).toEqual({
      [CIRCUIT_SOURCE.DL_STABLECOINS]: circuits[CIRCUIT_SOURCE.DL_STABLECOINS],
      [CIRCUIT_SOURCE.CG_PRICES]: circuits[CIRCUIT_SOURCE.CG_PRICES],
    });
    expect(countPublicImpactOpenCircuits(circuits)).toBe(2);
    expect(getCircuitImpactStatus(countPublicImpactOpenCircuits(circuits))).toBe("healthy");
  });

  // --- recoverBreakerOnNoCandidate ---

  describe("recoverBreakerOnNoCandidate", () => {
    it("records success when breaker is half-open so it can close on the next read", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });

    it("is a no-op when breaker is already closed", async () => {
      const stored = makeRecord({ state: "closed" });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT INTO cache"));
      expect(write).toBeUndefined();
    });

    it("records success when breaker is open (allowing recovery on next probe window)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 3600 });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });
  });
});
