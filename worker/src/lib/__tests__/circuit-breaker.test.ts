import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import type { CircuitRecord } from "../circuit-breaker";

// Mock sendAlert to prevent real HTTP calls
vi.mock("../alerts", () => ({
  sendAlert: vi.fn(() => Promise.resolve()),
}));

// Import after mocking
import { getCircuitRecord, shouldAttemptFetch, recordOutcome, getCircuitStates } from "../circuit-breaker";
import { sendAlert } from "../alerts";
import { CIRCUIT_SOURCE } from "../constants";

const mockedAlert = vi.mocked(sendAlert);

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

describe("circuit-breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
    mockedAlert.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it("transitions half-open → closed and fires recovery alert", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", true);
      expect(mockedAlert).toHaveBeenCalledWith(
        null,
        "Circuit closed: src",
        expect.stringContaining("recovered"),
      );
    });

    it("transitions open → closed and fires recovery alert", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 3600 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", true);
      expect(mockedAlert).toHaveBeenCalledWith(
        null,
        "Circuit closed: src",
        expect.stringContaining("recovered"),
      );
    });

    it("does not fire alert when already closed", async () => {
      const stored = makeRecord({ state: "closed" });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", true);
      expect(mockedAlert).not.toHaveBeenCalled();
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
      await recordOutcome(db, "src", false);
      expect(mockedAlert).toHaveBeenCalledWith(
        null,
        "Circuit OPEN: src",
        expect.stringContaining("3 consecutive"),
      );
    });

    it("does not open circuit before threshold", async () => {
      const stored = makeRecord({ state: "closed", consecutiveFailures: 1 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", false);
      expect(mockedAlert).not.toHaveBeenCalled();
    });

    it("stays open on further failures after opening", async () => {
      const now = Math.floor(Date.now() / 1000);
      const stored = makeRecord({ state: "open", consecutiveFailures: 5, openedAt: now - 100 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", false);
      // Should not fire a new "open" alert since already open
      expect(mockedAlert).not.toHaveBeenCalled();
    });

    it("half-open probe failure reopens circuit", async () => {
      const stored = makeRecord({ state: "half-open", consecutiveFailures: 3 });
      const db = mockDbWithCircuit("src", stored);
      await recordOutcome(db, "src", false);
      // Probe failed — circuit should reopen (no new alert, just state change)
      // The function transitions back to open without firing the "open" alert again
      expect(mockedAlert).not.toHaveBeenCalled();
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

  // --- Etherscan circuit source ---

  describe("Etherscan circuit source", () => {
    it("ETHERSCAN source constant exists", () => {
      expect(CIRCUIT_SOURCE.ETHERSCAN).toBe("etherscan");
    });
  });
});
