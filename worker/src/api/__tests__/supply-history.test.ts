import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeSupplyRow } from "./helpers/fixtures";
import { handleSupplyHistory } from "../supply-history";

describe("handleSupplyHistory", () => {
  const row = makeSupplyRow();

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: number; circulatingUsd: number; price: number | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("date");
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).toHaveProperty("price");
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "supply_history", rows: [] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 400 when stablecoin param is missing", async () => {
    const db = mockD1([]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 400 for invalid stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=<script>"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid stablecoin ID" });
  });

  it("maps snake_case columns to camelCase", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=1"));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).not.toHaveProperty("circulating_usd");
    expect(body[0]).not.toHaveProperty("snapshot_date");
  });
});
