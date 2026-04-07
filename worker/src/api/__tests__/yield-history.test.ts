import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeYieldHistoryRow } from "./helpers/fixtures";
import { handleYieldHistory } from "../yield-history";

describe("handleYieldHistory", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const row = makeYieldHistoryRow();

  it("returns 200 with history envelope", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: Record<string, unknown> | null;
      history: Array<Record<string, unknown>>;
      methodology: Record<string, unknown>;
    };
    expect(body.history).toHaveLength(1);
    expect(body.current).toEqual(body.history[0]);
    expect(body.history[0]).toHaveProperty("date");
    expect(body.history[0]).toHaveProperty("apy");
    expect(body.history[0]).toHaveProperty("apyBase");
    expect(body.history[0]).toHaveProperty("apyReward");
    expect(body.history[0]).toHaveProperty("exchangeRate");
    expect(body.history[0]).toHaveProperty("sourceTvlUsd");
    expect(body.history[0]).toHaveProperty("sourceKey");
    expect(body.history[0]).toHaveProperty("yieldSourceUrl");
    expect(body.history[0]).toHaveProperty("dataSource");
    expect(body.history[0]).toHaveProperty("isBest");
    expect(body.history[0]).toHaveProperty("sourceSwitch");
    expect(body.methodology).toHaveProperty("version");
  });

  it("returns 200 with empty history when no data", async () => {
    const db = mockD1([{ match: "yield_history", rows: [] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = await res.json() as { current: null; history: unknown[] };
    expect(body.current).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("returns 400 when stablecoin param is missing", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 404 for unknown stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=DROP TABLE"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=9999"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid days: must be between 1 and 365" });
  });

  it("maps snake_case to camelCase", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as { history: Array<Record<string, unknown>> };
    expect(body.history[0]).not.toHaveProperty("recorded_at");
    expect(body.history[0]).not.toHaveProperty("apy_base");
    expect(body.history[0]).not.toHaveProperty("apy_reward");
    expect(body.history[0]).not.toHaveProperty("exchange_rate");
    expect(body.history[0]).not.toHaveProperty("source_tvl_usd");
  });

  it("supports source-specific history mode", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(
      db,
      new URL(`https://x/api/yield-history?stablecoin=usdt-tether&sourceKey=${encodeURIComponent("aave-v3:usdt")}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ sourceKey: string }> };
    expect(body.history[0]?.sourceKey).toBe("aave-v3:usdt");
  });

  it("marks the transition from legacy-best to a source-aware row as a source switch", async () => {
    const legacyRow = makeYieldHistoryRow({
      source_key: "legacy-best",
      recorded_at: 1_771_000_000,
      data_source: "price-derived",
      yield_source: null,
      yield_type: null,
    });
    const newRow = makeYieldHistoryRow({
      source_key: "rate-derived",
      recorded_at: 1_771_086_400,
      data_source: "rate-derived",
      yield_source: "T-bill proxy",
      yield_type: "nav-appreciation",
    });
    const db = mockD1([{ match: "yield_history", rows: [legacyRow, newRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ sourceKey: string; sourceSwitch: boolean }> };
    expect(body.history[0]).toMatchObject({ sourceKey: "legacy-best", sourceSwitch: false });
    expect(body.history[1]).toMatchObject({ sourceKey: "rate-derived", sourceSwitch: true });
  });

  it("normalizes legacy LUSD deterministic keys in best-mode history without a synthetic switch", async () => {
    const legacyRow = makeYieldHistoryRow({
      source_key: "bprotocol-lqty-only",
      recorded_at: 1_773_960_283,
      data_source: "onchain",
      yield_source: "B.Protocol Stability Pool (LQTY only)",
      yield_type: "lending-vault",
    });
    const normalizedRow = makeYieldHistoryRow({
      source_key: "onchain:lusd-liquity",
      recorded_at: 1_773_962_101,
      data_source: "onchain",
      yield_source: "B.Protocol Stability Pool (LQTY only)",
      yield_type: "lending-vault",
    });
    const db = mockD1([{ match: "yield_history", rows: [legacyRow, normalizedRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=lusd-liquity"));
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ sourceKey: string; sourceSwitch: boolean }> };
    expect(body.history[0]).toMatchObject({ sourceKey: "onchain:lusd-liquity", sourceSwitch: false });
    expect(body.history[1]).toMatchObject({ sourceKey: "onchain:lusd-liquity", sourceSwitch: false });
  });

  it("falls back to an empty warning list when warning_signals is malformed JSON", async () => {
    const malformedRow = makeYieldHistoryRow({ warning_signals: "not-json" });
    const db = mockD1([{ match: "yield_history", rows: [malformedRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<{ warningSignals: string[] }> };
    expect(body.history[0]?.warningSignals).toEqual([]);
  });

  it("uses the hourly yield freshness budget for history responses", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 3_500;
    const historyRow = makeYieldHistoryRow({ recorded_at: updatedAt });
    const db = mockD1([{ match: "yield_history", rows: [historyRow] }]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe("3500");
  });

  it("falls back to the latest successful yield cron timestamp when the yield-rankings cache is malformed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T12:00:00Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const latestSuccessfulCronAt = nowSec - 1_800;

    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["yield-rankings"],
        rows: [],
        first: { value: "{bad-json", updated_at: nowSec - 60 },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs",
        rows: [],
        first: { started_at: latestSuccessfulCronAt },
      },
      { match: "yield_history", rows: [row] },
    ]);

    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);

    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("FROM yield_history"));
    expect(historyQuery?.binds[2]).toBe(latestSuccessfulCronAt);
  });
});
