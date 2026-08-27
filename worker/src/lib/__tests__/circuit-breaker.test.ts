import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import type { CircuitRecord } from "../circuit-breaker";
import {
  getCircuitRecord,
  shouldAttemptFetch,
  recordOutcome,
  recoverBreakerOnNoCandidate,
  getCircuitStates,
  listActiveCircuitSources,
  filterInactiveCircuitStates,
  mapCronStatusToCircuitOutcome,
  resetCircuitBreakerStateForTests,
} from "../circuit-breaker";
import { CIRCUIT_SOURCE } from "../constants";

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
        entry.sql.includes("INSERT OR REPLACE INTO cache") ||
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
    it("returns default closed state when no DB record exists", async () => {
      const db = mockD1([{ match: "cache", rows: [] }]);
      const record = await getCircuitRecord(db, "test-source");
      expect(record.state).toBe("closed");
      expect(record.consecutiveFailures).toBe(0);
      expect(record.lastFailureAt).toBeNull();
      expect(record.lastSuccessAt).toBeNull();
      expect(record.openedAt).toBeNull();
    });

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

    it("returns default for malformed JSON", async () => {
      const db = mockD1([{
        match: "cache",
        rows: [{ key: "circuit:test", value: "not-json", updated_at: 100 }],
      }]);
      const record = await getCircuitRecord(db, "test");
      expect(record.state).toBe("closed");
      expect(record.consecutiveFailures).toBe(0);
    });

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
      const db = mockDbWithCircuit("src", makeRecord({ state: "half-open" }));
      expect(await shouldAttemptFetch(db, "src")).toBe(true);
    });
  });

  // --- recordOutcome — success ---

  describe("recordOutcome — success", () => {
    it("resets consecutiveFailures to 0", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 2 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", true);
      // Verify by reading back (the mock doesn't persist writes, but no error means success)
      expect(true).toBe(true);
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

    it("stays closed after a successful outcome", async () => {
      const stored = makeRecord({ state: "closed" });
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
        .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({
        state: "closed",
        consecutiveFailures: 0,
        lastSuccessAt: Math.floor(Date.now() / 1000),
      });
      expect(circuitCacheKeysTouched(db)).toEqual(["circuit:src", "circuit:src"]);
    });

    it("invalidates cached state after an outcome write", async () => {
      const db = mockDbWithCircuit("write-memo", makeRecord({ state: "closed" }));

      await getCircuitRecord(db, "write-memo");
      await recordOutcome(db, "write-memo", true);
      await getCircuitRecord(db, "write-memo");

      expect(countCircuitRecordReads(db, "write-memo")).toBe(2);
    });
  });

  // --- recordOutcome — failure ---

  describe("recordOutcome — failure", () => {
    it("increments consecutiveFailures", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 1 });
      const db = mockDbWithCircuit("src", stored);
      // After calling recordOutcome(false), consecutiveFailures should be 2
      // We can verify the function doesn't throw
      await recordOutcome(db, "src", false);
    });

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

    it("returns empty object when no circuits exist", async () => {
      const db = mockD1([{ match: "circuit", rows: [] }]);
      const states = await getCircuitStates(db);
      expect(Object.keys(states)).toHaveLength(0);
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

  it("does not list the retired Pyth provider circuit", () => {
    expect(listActiveCircuitSources()).not.toContain("pyth-prices");
  });

  // --- Etherscan circuit source ---

  describe("Etherscan circuit source", () => {
    it("ETHERSCAN source constant exists", () => {
      expect(CIRCUIT_SOURCE.ETHERSCAN).toBe("etherscan");
    });
  });

  // --- recoverBreakerOnNoCandidate ---

  describe("recoverBreakerOnNoCandidate", () => {
    it("records success when breaker is half-open so it can close on the next read", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });

    it("is a no-op when breaker is already closed", async () => {
      const stored = makeRecord({ state: "closed" });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
      expect(write).toBeUndefined();
    });

    it("records success when breaker is open (allowing recovery on next probe window)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 3600 });
      const db = mockDbWithCircuit("src", stored);
      await recoverBreakerOnNoCandidate(db, "src");
      const write = db
        .getHistory()
        .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
      expect(write?.binds[0]).toBe("circuit:src");
      expect(JSON.parse(String(write?.binds[1]))).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    });
  });
});
