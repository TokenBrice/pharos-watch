import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeSupplyRow } from "./helpers/fixtures";
import { handleSupplyHistory } from "../supply-history";

describe("handleSupplyHistory", () => {
  const row = makeSupplyRow();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ date: number; circulatingUsd: number; price: number | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("date");
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).toHaveProperty("price");
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "supply_history", rows: [] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
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

  it("returns 404 for unknown stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=<script>"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=9999"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid days: must be between 1 and 1825" });
  });

  it("maps snake_case columns to camelCase", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).not.toHaveProperty("circulating_usd");
    expect(body[0]).not.toHaveProperty("snapshot_date");
  });

  it("includes freshness headers from the latest successful supply snapshot run", async () => {
    const nowSec = 1_765_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const db = mockD1(
      [
        {
          match: "FROM cache",
          matchBinds: ["snapshot-supply:last-write"],
          rows: [{
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: row.snapshot_date }),
            updated_at: nowSec - 300,
          }],
          first: {
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: row.snapshot_date }),
            updated_at: nowSec - 300,
          },
        },
        {
          match: "FROM supply_history",
          matchBinds: ["usdt-tether", nowSec - 365 * 86_400, row.snapshot_date],
          rows: [row],
        },
        {
          match: "FROM cron_runs",
          matchBinds: ["snapshot-supply"],
          rows: [{ started_at: nowSec - 300 }],
          first: { started_at: nowSec - 300 },
        },
      ],
      { requireMatch: true },
    );

    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Data-Age")).toBe("300");
    expect(res.headers.get("Warning")).toBeNull();
    db.assertAllMatchesUsed();
  });
});
