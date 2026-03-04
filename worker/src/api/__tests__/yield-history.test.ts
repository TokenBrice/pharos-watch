import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeYieldHistoryRow } from "./helpers/fixtures";
import { handleYieldHistory } from "../yield-history";

describe("handleYieldHistory", () => {
  const row = makeYieldHistoryRow();

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      date: number; apy: number; apyBase: number | null;
      apyReward: number | null; exchangeRate: number | null;
      sourceTvlUsd: number | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("date");
    expect(body[0]).toHaveProperty("apy");
    expect(body[0]).toHaveProperty("apyBase");
    expect(body[0]).toHaveProperty("apyReward");
    expect(body[0]).toHaveProperty("exchangeRate");
    expect(body[0]).toHaveProperty("sourceTvlUsd");
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "yield_history", rows: [] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 400 when stablecoin param is missing", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 400 for invalid stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=DROP TABLE"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid stablecoin ID" });
  });

  it("maps snake_case to camelCase", async () => {
    const db = mockD1([{ match: "yield_history", rows: [row] }]);
    const res = await handleYieldHistory(db, new URL("https://x/api/yield-history?stablecoin=1"));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).not.toHaveProperty("recorded_at");
    expect(body[0]).not.toHaveProperty("apy_base");
    expect(body[0]).not.toHaveProperty("apy_reward");
    expect(body[0]).not.toHaveProperty("exchange_rate");
    expect(body[0]).not.toHaveProperty("source_tvl_usd");
  });
});
