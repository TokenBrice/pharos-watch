import { describe, it, expect } from "vitest";
import {
  buildDewsSnapshot,
  buildDewsAlertableSnapshot,
  buildDepegSnapshot,
  buildSafetySnapshot,
  filterAlertableBands,
  parseSnapshotMap,
  isSnapshotMissingOrStale,
  extractTopSignals,
  isSafetyDeescalation,
  SNAPSHOT_MAX_AGE_SEC,
  type DewsRow,
  type ActiveDepegRow,
  type SafetyRow,
} from "../telegram-alert-snapshots";

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
});

describe("buildSafetySnapshot", () => {
  it("maps safety rows to grade/score/version", () => {
    const rows: SafetyRow[] = [{
      stablecoin_id: "usdc-circle",
      grade: "A",
      score: 92,
      prev_grade: "B+",
      prev_score: 85,
      recorded_at: 1000,
      methodology_version: "v2",
    }];
    expect(buildSafetySnapshot(rows)).toEqual({
      "usdc-circle": { grade: "A", score: 92, methodologyVersion: "v2" },
    });
  });

  it("handles null score and methodology_version", () => {
    const rows: SafetyRow[] = [{
      stablecoin_id: "x",
      grade: "NR",
      score: null,
      prev_grade: null,
      prev_score: null,
      recorded_at: 1000,
      methodology_version: null,
    }];
    expect(buildSafetySnapshot(rows)).toEqual({
      x: { grade: "NR", score: null, methodologyVersion: null },
    });
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
});

describe("isSafetyDeescalation", () => {
  it("returns true when new grade is higher rank", () => {
    expect(isSafetyDeescalation("B", "A")).toBe(true);
  });

  it("returns false when new grade is lower rank", () => {
    expect(isSafetyDeescalation("A", "B")).toBe(false);
  });

  it("returns false for unknown grades", () => {
    expect(isSafetyDeescalation("X", "A")).toBe(false);
  });

  it("returns false for equal grades", () => {
    expect(isSafetyDeescalation("B", "B")).toBe(false);
  });
});
