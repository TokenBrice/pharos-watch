import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import {
  buildDewsSnapshot,
  buildDewsAlertableSnapshot,
  buildDepegSnapshot,
  filterAlertableBands,
  parseSnapshotMap,
  isSnapshotMissingOrStale,
  extractTopSignals,
  isSafetyDeescalation,
  writeSnapshots,
  SNAPSHOT_KEYS,
  SNAPSHOT_MAX_AGE_SEC,
  type DewsRow,
  type ActiveDepegRow,
} from "../telegram-alert-snapshots";

const DEFAULT_TELEGRAM_SNAPSHOT_D1_TABLES: MockTableConfig[] = [
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_TELEGRAM_SNAPSHOT_D1_TABLES]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSnapshotMap", () => {
  it("parses valid JSON into a record", () => {
    const cached = { value: JSON.stringify({ "usdc-circle": "ALERT" }), updatedAt: 1000 };
    expect(parseSnapshotMap(cached)).toEqual({ "usdc-circle": "ALERT" });
  });

  it("returns null for null input", () => {
    expect(parseSnapshotMap(null)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSnapshotMap({ value: "not json{", updatedAt: 1000 })).toBeNull();
  });

  it("returns null for array JSON", () => {
    expect(parseSnapshotMap({ value: "[]", updatedAt: 1000 })).toBeNull();
  });

  it("returns null for primitive JSON", () => {
    expect(parseSnapshotMap({ value: '"string"', updatedAt: 1000 })).toBeNull();
  });
});

describe("isSnapshotMissingOrStale", () => {
  it("returns true for null cache", () => {
    expect(isSnapshotMissingOrStale(null, 1000)).toBe(true);
  });

  it("returns true when snapshot is older than max age", () => {
    const cached = { value: "{}", updatedAt: 1000 };
    expect(isSnapshotMissingOrStale(cached, 1000 + SNAPSHOT_MAX_AGE_SEC + 1)).toBe(true);
  });

  it("returns false when snapshot is fresh", () => {
    const cached = { value: "{}", updatedAt: 1000 };
    expect(isSnapshotMissingOrStale(cached, 1000 + 60)).toBe(false);
  });
});

describe("buildDewsSnapshot", () => {
  it("maps rows to stablecoinId → band", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    expect(buildDewsSnapshot(rows)).toEqual({
      "usdc-circle": "ALERT",
      "dai-maker": "CALM",
    });
  });

  it("returns empty object for empty input", () => {
    expect(buildDewsSnapshot([])).toEqual({});
  });
});

describe("buildDewsAlertableSnapshot", () => {
  it("only includes alertable bands and preserves previous entries", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "ALERT", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    const previous = { "old-coin": "WARNING" };
    const result = buildDewsAlertableSnapshot(rows, previous);
    expect(result).toEqual({
      "old-coin": "WARNING",
      "usdc-circle": "ALERT",
    });
    expect(result["dai-maker"]).toBeUndefined();
  });

  it("builds from scratch when no previous snapshot is provided", () => {
    const rows: DewsRow[] = [
      { stablecoin_id: "usdc-circle", score: 42, band: "WARNING", signals_json: null },
      { stablecoin_id: "dai-maker", score: 10, band: "CALM", signals_json: null },
    ];
    const result = buildDewsAlertableSnapshot(rows);
    expect(result).toEqual({ "usdc-circle": "WARNING" });
  });
});

describe("filterAlertableBands", () => {
  it("filters to only ALERT/WARNING/DANGER", () => {
    const snapshot = { a: "ALERT", b: "CALM", c: "WARNING", d: "WATCH", e: "DANGER" };
    expect(filterAlertableBands(snapshot)).toEqual({ a: "ALERT", c: "WARNING", e: "DANGER" });
  });

  it("returns empty object for null", () => {
    expect(filterAlertableBands(null)).toEqual({});
  });
});

describe("buildDepegSnapshot", () => {
  it("maps active depeg rows to structured payloads", () => {
    const rows: ActiveDepegRow[] = [{
      stablecoin_id: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      peak_deviation_bps: 150,
      start_price: 0.985,
      peak_price: 0.985,
      peg_reference: 1,
    }];
    const result = buildDepegSnapshot(rows);
    expect(result["usdc-circle"]).toEqual({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      deviationBps: 150,
      price: 0.985,
      pegReference: 1,
    });
  });

  it("uses peak_price for active depeg display price when the event worsened after opening", () => {
    const rows: ActiveDepegRow[] = [{
      stablecoin_id: "pmusd-pm",
      symbol: "pmUSD",
      direction: "below",
      peak_deviation_bps: -5940,
      start_price: 0.9884,
      peak_price: 0.406,
      peg_reference: 1,
    }];

    expect(buildDepegSnapshot(rows)["pmusd-pm"]).toEqual(
      expect.objectContaining({
        deviationBps: 5940,
        price: 0.406,
      }),
    );
  });
});

describe("extractTopSignals", () => {
  it("returns top 2 signals sorted by value descending", () => {
    const json = JSON.stringify({
      liquidity: { value: 0.8, available: true },
      volatility: { value: 0.5, available: true },
      reserves: { value: 0.9, available: true },
    });
    const result = extractTopSignals(json);
    expect(result).toEqual([
      { name: "reserves", value: 0.9 },
      { name: "liquidity", value: 0.8 },
    ]);
  });

  it("returns empty array for null input", () => {
    expect(extractTopSignals(null)).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(extractTopSignals("not json")).toEqual([]);
  });

  it("excludes signals with available=false", () => {
    const json = JSON.stringify({
      liquidity: { value: 0.8, available: false },
      volatility: { value: 0.5, available: true },
    });
    expect(extractTopSignals(json)).toEqual([{ name: "volatility", value: 0.5 }]);
  });

  it("unwraps the v5.95 wrapped shape { signals, amplifiers } before extracting", () => {
    const json = JSON.stringify({
      signals: {
        liquidity: { value: 0.8, available: true },
        volatility: { value: 0.5, available: true },
        reserves: { value: 0.9, available: true },
      },
      amplifiers: { psi: 1.08, contagion: 1.15 },
    });
    // Same top-2 as the flat legacy shape — the amplifiers envelope is stripped.
    expect(extractTopSignals(json)).toEqual([
      { name: "reserves", value: 0.9 },
      { name: "liquidity", value: 0.8 },
    ]);
  });

  it("produces identical output for flat and wrapped shapes of the same signals", () => {
    const payload = {
      liquidity: { value: 0.8, available: true },
      volatility: { value: 0.5, available: true },
    };
    const flat = JSON.stringify(payload);
    const wrapped = JSON.stringify({ signals: payload, amplifiers: { psi: 1, contagion: 1 } });
    expect(extractTopSignals(flat)).toEqual(extractTopSignals(wrapped));
  });
});

describe("isSafetyDeescalation", () => {
  it("returns true when new grade is higher rank", () => {
    expect(isSafetyDeescalation("B", "A")).toBe(true);
  });

  it("returns false when new grade is lower rank", () => {
    expect(isSafetyDeescalation("A", "B")).toBe(false);
  });

  it("treats unknown grades as lower than NR when comparing deescalation", () => {
    expect(isSafetyDeescalation("X", "NR")).toBe(true);
    expect(isSafetyDeescalation("NR", "X")).toBe(false);
  });

  it("returns false for equal grades", () => {
    expect(isSafetyDeescalation("B", "B")).toBe(false);
  });
});

describe("writeSnapshots", () => {
  it("persists the non-safety snapshots in one D1 batch with shared metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
    const db = mockD1([]);
    const originalBatch = db.batch.bind(db);
    const batchSizes: number[] = [];
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    }) as D1Database["batch"];

    await writeSnapshots(db, {
      dews: { "usdc-circle": "CALM" },
      dewsAlertable: {},
      depeg: {},
      launch: ["usdc-circle"],
      reserveDispatched: null,
    });

    expect(batchSizes).toEqual([5]);
    const writes = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    expect(writes.map((entry) => entry.binds[0])).toEqual([
      SNAPSHOT_KEYS.dews,
      SNAPSHOT_KEYS.dewsAlertable,
      SNAPSHOT_KEYS.depeg,
      SNAPSHOT_KEYS.launch,
      SNAPSHOT_KEYS.reserveDispatched,
    ]);
    expect(new Set(writes.map((entry) => entry.binds[2]))).toEqual(new Set([1776945600]));
    expect(writes.find((entry) => entry.binds[0] === SNAPSHOT_KEYS.reserveDispatched)?.binds[1]).toBe("null");
  });

  it("includes the safety snapshot in the same D1 batch when present", async () => {
    const db = mockD1([]);
    const originalBatch = db.batch.bind(db);
    const batchSizes: number[] = [];
    db.batch = (async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      return originalBatch(statements);
    }) as D1Database["batch"];

    await writeSnapshots(db, {
      dews: {},
      dewsAlertable: {},
      depeg: {},
      safety: { generation: "test", snapshot: { "usdc-circle": { grade: "A", score: 90, methodologyVersion: "v1" } } },
      launch: [],
      reserveDispatched: [],
    });

    expect(batchSizes).toEqual([6]);
    const keys = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))
      .map((entry) => entry.binds[0]);
    expect(keys).toContain(SNAPSHOT_KEYS.safety);
  });
});
