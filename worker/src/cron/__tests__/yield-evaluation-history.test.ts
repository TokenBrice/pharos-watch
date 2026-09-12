import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildHistoryKey, pickHistoryRowsForSource } from "../yield-sync/evaluation-history";
import type { YieldHistorySnapshotRow } from "../yield-sync/history";

// D5: the legacy carry-forward branch decides whether a switched row inherits
// or silently empties its 30-day window (apy30d, apyVarianceScore,
// observationCount30d, PYS), so the acceptance and each rejection guard are
// pinned here.

const COIN_ID = "test-coin";
const CURRENT_SOURCE_KEY = "defillama:new-source";
const CURRENT_DATA_SOURCE = "defillama";
/** evaluation-history.ts's private bound: a 30-day window plus 5 days of slack. */
const LEGACY_HISTORY_MAX_AGE_SEC = 35 * DAY_SECONDS;
const START_SEC = 1_774_000_000;

function legacyRow(
  recordedAt: number,
  overrides: Partial<YieldHistorySnapshotRow> = {},
): YieldHistorySnapshotRow {
  return {
    stablecoin_id: COIN_ID,
    source_key: "legacy-best",
    recorded_at: recordedAt,
    is_best: 1,
    apy: 4.6,
    apy_base: null,
    source_tvl_usd: 1_000_000,
    data_source: CURRENT_DATA_SOURCE,
    yield_source: "Legacy Source",
    yield_type: "lending-vault",
    exchange_rate: null,
    ...overrides,
  };
}

function pick(params: {
  legacyRows?: YieldHistorySnapshotRow[];
  resolvedCount?: number;
  dataSource?: string;
} = {}) {
  return pickHistoryRowsForSource(
    COIN_ID,
    CURRENT_SOURCE_KEY,
    params.dataSource ?? CURRENT_DATA_SOURCE,
    new Map(),
    new Map(),
    new Map(),
    params.legacyRows ? new Map([[COIN_ID, params.legacyRows]]) : new Map(),
    params.resolvedCount == null ? new Map() : new Map([[COIN_ID, params.resolvedCount]]),
    START_SEC,
  );
}

describe("pickHistoryRowsForSource legacy carry-forward", () => {
  it("carries fresh same-family legacy history into a switched row", () => {
    const fresh = legacyRow(START_SEC - 2 * DAY_SECONDS);
    const outsideWindow = legacyRow(START_SEC - LEGACY_HISTORY_MAX_AGE_SEC - 1, { apy: 9 });

    const result = pick({ legacyRows: [fresh, outsideWindow] });

    // The coin has no resolved candidate (`resolvedCountByCoin` defaults to 0)
    // and the rows all belong to the current family, so the window carries over.
    expect(result).toEqual({ rows: [fresh], usedLegacyHistory: true });
  });

  it.each([
    { label: "just inside the 35-day bound", ageSec: LEGACY_HISTORY_MAX_AGE_SEC - 1, accepted: true },
    { label: "exactly at the 35-day bound", ageSec: LEGACY_HISTORY_MAX_AGE_SEC, accepted: true },
    { label: "one second past the 35-day bound", ageSec: LEGACY_HISTORY_MAX_AGE_SEC + 1, accepted: false },
  ])("$label — carried forward: $accepted", ({ ageSec, accepted }) => {
    const result = pick({ legacyRows: [legacyRow(START_SEC - ageSec)], resolvedCount: 1 });

    expect(result.usedLegacyHistory).toBe(accepted);
    expect(result.rows).toHaveLength(accepted ? 1 : 0);
  });

  it("rejects legacy history once more than one candidate resolved for the coin", () => {
    const result = pick({ legacyRows: [legacyRow(START_SEC - DAY_SECONDS)], resolvedCount: 2 });

    expect(result).toEqual({ rows: [], usedLegacyHistory: false });
  });

  it("rejects legacy history that belongs to another data-source family", () => {
    const result = pick({
      legacyRows: [legacyRow(START_SEC - DAY_SECONDS, { data_source: "onchain" })],
      resolvedCount: 1,
    });

    expect(result).toEqual({ rows: [], usedLegacyHistory: false });
  });

  it("rejects legacy history whose rows mix data-source families", () => {
    const result = pick({
      legacyRows: [
        legacyRow(START_SEC - DAY_SECONDS),
        legacyRow(START_SEC - 2 * DAY_SECONDS, { data_source: "onchain" }),
      ],
      resolvedCount: 1,
    });

    expect(result).toEqual({ rows: [], usedLegacyHistory: false });
  });

  it("prefers keyed source history over the legacy window", () => {
    const keyed = legacyRow(START_SEC - DAY_SECONDS, { source_key: CURRENT_SOURCE_KEY, apy: 5.1 });
    const result = pickHistoryRowsForSource(
      COIN_ID,
      CURRENT_SOURCE_KEY,
      CURRENT_DATA_SOURCE,
      new Map([[buildHistoryKey(COIN_ID, CURRENT_SOURCE_KEY), [keyed]]]),
      new Map(),
      new Map(),
      new Map([[COIN_ID, [legacyRow(START_SEC - DAY_SECONDS, { apy: 4.2 })]]]),
      new Map(),
      START_SEC,
    );

    expect(result).toEqual({ rows: [keyed], usedLegacyHistory: false });
  });
});
