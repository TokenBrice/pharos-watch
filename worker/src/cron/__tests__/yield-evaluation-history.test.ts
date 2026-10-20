import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildHistoryKey, pickHistoryRowsForSource } from "../yield-sync/history";
import type { YieldHistorySnapshotRow } from "../yield-sync/history";
import { evaluateYieldSourcesCooperative } from "../yield-sync/evaluation";
import { baseEvaluationInput, resolvedYield } from "./yield-evaluation.test-support";

// Legacy carry-forward decides whether a switched row inherits or empties its
// loaded 30-day window, so the acceptance and semantic rejection guards stay
// pinned here.

const COIN_ID = "test-coin";
const CURRENT_SOURCE_KEY = "defillama:new-source";
const CURRENT_DATA_SOURCE = "defillama";
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
  );
}

describe("pickHistoryRowsForSource legacy carry-forward", () => {
  it("carries same-family legacy history into a switched row", () => {
    const fresh = legacyRow(START_SEC - 2 * DAY_SECONDS);

    const result = pick({ legacyRows: [fresh] });

    expect(result).toEqual({ rows: [fresh], usedLegacyHistory: true });
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
    );

    expect(result).toEqual({ rows: [keyed], usedLegacyHistory: false });
  });
});

describe("current anchor-only resolution", () => {
  it.each(["onchain", "protocol-api"] as const)("excludes %s re-anchor seeds before statistics and arbitration", async (dataSource) => {
    const input = baseEvaluationInput();
    const sourceKey = `${dataSource}:coin-a:nav`;
    const seed = { id: "coin-a", symbol: "A", yield: resolvedYield({
      observationKind: "anchor-only", dataSource, sourceKey,
      currentApy: 0, apyBase: null, exchangeRate: 1.1,
    }) };
    input.resolved = [seed];
    input.sourceHistory.set(buildHistoryKey("coin-a", sourceKey), [
      { ...legacyRow(input.startSec - DAY_SECONDS), stablecoin_id: "coin-a", source_key: sourceKey, apy: 6 },
    ]);
    const anchorOnly = await evaluateYieldSourcesCooperative(input, { yieldToEventLoop: () => Promise.resolve() });
    expect(anchorOnly.evaluatedSources).toEqual([]);
    expect(anchorOnly.bestSourceKeyByCoin.size).toBe(0);
    expect(anchorOnly.medianApy).toBeNull();
    expect(anchorOnly.rowsRejected).toBe(0);

    const measured = { id: "coin-a", symbol: "A", yield: resolvedYield({ currentApy: 4, apyBase: 4 }) };
    input.resolved = [seed, measured];
    const withAlternative = await evaluateYieldSourcesCooperative(input, { yieldToEventLoop: () => Promise.resolve() });
    expect(withAlternative.evaluatedSources).toHaveLength(1);
    expect(withAlternative.bestSourceKeyByCoin.get("coin-a")).toBe(measured.yield.sourceKey);
    expect(withAlternative.evaluatedSources[0]).toMatchObject({ currentApy: 4, apy7d: 4, apy30d: 4 });
  });

  it.each([0, -2])("keeps a genuinely measured %s%% return after an anchor-only observation", async (apy) => {
    const input = baseEvaluationInput();
    const sourceKey = "onchain:coin-a";
    input.resolved = [{ id: "coin-a", symbol: "A", yield: resolvedYield({
      sourceKey, dataSource: "onchain", currentApy: apy, apyBase: apy, exchangeRate: 1,
    }) }];
    input.sourceHistory.set(buildHistoryKey("coin-a", sourceKey), [{
      ...legacyRow(input.startSec - 7 * DAY_SECONDS), stablecoin_id: "coin-a", source_key: sourceKey,
      data_source: "onchain", apy: 0, apy_base: null, exchange_rate: 1,
    }]);
    const result = await evaluateYieldSourcesCooperative(input, { yieldToEventLoop: () => Promise.resolve() });
    expect(result.evaluatedSources[0]).toMatchObject({ currentApy: apy, apy7d: apy, apy30d: apy });
    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe(sourceKey);
  });
});
