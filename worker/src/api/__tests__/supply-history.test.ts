import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { makeSupplyRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleSupplyHistory } from "../supply-history";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  const hasCacheFixture = tables.some((table) => table.match.includes("FROM cache"));
  return baseMockD1(
    hasCacheFixture
      ? tables
      : [...tables, { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null }],
    options,
  );
}

describe("handleSupplyHistory", () => {
  const row = makeSupplyRow();

  afterEach(() => {
    fixtures.closeAll();
    vi.restoreAllMocks();
  });

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    const body = (await readJsonResponse(res, 200)) as Array<{ date: number; circulatingUsd: number; price: number | null }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("date");
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).toHaveProperty("price");
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "supply_history", rows: [] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    const body = await readJsonResponse(res, 200);
    expect(body).toEqual([]);
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const db = mockD1([], { requireMatch: true });
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=9999"));
    expect(await readJsonResponse(res, 400)).toEqual({ error: "Invalid days: must be between 1 and 5000" });
    expect(db.getHistory()).toEqual([]);
  });

  it("accepts long history windows for all-time market structure overlays", async () => {
    const nowSec = 1_765_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const db = mockD1(
      [
        {
          match: "FROM cache",
          matchBinds: ["snapshot-supply:last-write"],
          rows: [],
          first: null,
        },
        {
          match: "FROM supply_history",
          matchBinds: ["usdt-tether", nowSec - 5000 * 86_400],
          rows: [row],
        },
      ],
      { requireMatch: true },
    );

    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=5000"));

    expect(await readJsonResponse(res, 200)).toEqual([
      {
        date: row.snapshot_date,
        circulatingUsd: row.circulating_usd,
        price: row.price,
      },
    ]);
    db.assertAllMatchesUsed();
  });

  it("maps snake_case columns to camelCase", async () => {
    const db = mockD1([{ match: "supply_history", rows: [row] }]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).toHaveProperty("circulatingUsd");
    expect(body[0]).not.toHaveProperty("circulating_usd");
    expect(body[0]).not.toHaveProperty("snapshot_date");
  });

  it("includes freshness headers from the completed supply snapshot marker", async () => {
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
      ],
      { requireMatch: true },
    );

    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Data-Age")).toBe("300");
    expect(res.headers.get("Warning")).toBeNull();
    db.assertAllMatchesUsed();
  });

  it("reports stale freshness when the completed snapshot marker is old", async () => {
    const nowSec = 1_765_000_000;
    const markerUpdatedAt = nowSec - 9 * 86_400;
    vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);
    const db = mockD1(
      [
        {
          match: "FROM cache",
          matchBinds: ["snapshot-supply:last-write"],
          rows: [{
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: row.snapshot_date }),
            updated_at: markerUpdatedAt,
          }],
          first: {
            key: "snapshot-supply:last-write",
            value: JSON.stringify({ snapshotDate: row.snapshot_date }),
            updated_at: markerUpdatedAt,
          },
        },
        {
          match: "FROM supply_history",
          matchBinds: ["usdt-tether", nowSec - 365 * 86_400, row.snapshot_date],
          rows: [row],
        },
      ],
      { requireMatch: true },
    );

    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Data-Age")).toBe(String(9 * 86_400));
    expect(res.headers.get("Warning")).toContain("Response is stale");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM cron_runs"))).toBe(false);
    db.assertAllMatchesUsed();
  });

  it("fences completed publication inclusively and returns chronological history", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES ('usdt-tether', ?, ?, 1)");
    for (const offset of [-10, 1, 0]) insert.run(now + offset, 100 + offset);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(JSON.stringify({ snapshotDate: now }), now);
    expect(await readJsonResponse(await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether")), 200)).toEqual([
      { date: now - 10, circulatingUsd: 90, price: 1 },
      { date: now, circulatingUsd: 100, price: 1 },
    ]);
  });

  it("uses the newest markerless row for freshness and leaves empty history unfreshened", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const url = new URL("https://x/api/supply-history?stablecoin=usdt-tether");
    const empty = await handleSupplyHistory(db, url);
    expect(await readJsonResponse(empty, 200)).toEqual([]);
    expect(empty.headers.get("X-Data-Age")).toBeNull();
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES ('usdt-tether', ?, 10, 1), ('usdt-tether', ?, 20, 1)").run(now - 30, now - 300);
    const populated = await handleSupplyHistory(db, url);
    expect(populated.headers.get("X-Data-Age")).toBe("30");
    expect(await readJsonResponse(populated, 200)).toEqual([
      { date: now - 300, circulatingUsd: 20, price: 1 },
      { date: now - 30, circulatingUsd: 10, price: 1 },
    ]);
  });
});

registerStablecoinParameterContract({
  name: "supply history",
  path: "/api/supply-history",
  invoke: handleSupplyHistory,
});
