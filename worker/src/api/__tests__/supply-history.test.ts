import * as perimeters from "@shared/lib/supply-perimeter-changes";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { makeChainGapGuard } from "@shared/test-utils/stablecoin";
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

  it("rejects a future served-row fallback clock instead of minting freshness", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const db = mockD1([{ match: "supply_history", rows: [{ ...row, snapshot_date: now + 61 }] }]);
    const response = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"), null);
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Freshness-Reason")).toBe("future-timestamp");
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=9999"));
    expect(await readJsonResponse(res, 400)).toEqual({ error: "Invalid days: must be between 1 and 5000" });
    expect(db.getHistory()).toEqual([]);
  });

  it.each(["", "1y", "ALL"])("rejects invalid supply range=%s before reading D1", async (range) => {
    const db = mockD1([]);
    const response = await handleSupplyHistory(db, new URL(`https://x/api/supply-history?stablecoin=usdt-tether&range=${range}`));
    expect(await readJsonResponse(response, 400)).toEqual({ error: "Invalid range: expected 'all'" });
    expect(db.getHistory()).toEqual([]);
  });

  it("rejects ambiguous all plus days instead of silently changing the requested window", async () => {
    const db = mockD1([]);
    const response = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&range=all&days=365"));
    expect(await readJsonResponse(response, 400)).toEqual({ error: "Specify either range=all or days, not both" });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([
    ["", 400, "Missing ?stablecoin= parameter"],
    ["&stablecoin=not-a-tracked-coin", 404, "Unknown stablecoin"],
  ] as const)("keeps stablecoin admission for range=all (%s)", async (stablecoin, status, error) => {
    const db = mockD1([]);
    const response = await handleSupplyHistory(db, new URL(`https://x/api/supply-history?range=all${stablecoin}`));
    expect(await readJsonResponse(response, status)).toEqual({ error });
    expect(db.getHistory()).toEqual([]);
  });

  it.each([
    ["", [-365, -90, 0]],
    ["&days=365", [-365, -90, 0]],
    ["&days=90", [-90, 0]],
    ["&range=all", [-6000, -366, -365, -90, 0]],
  ] as const)("serves the requested retained window with the completed-snapshot fence (%s)", async (query, offsets) => {
    const now = 1_800_000_000;
    const day = 86_400;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)");
    for (const offset of [1, 0, -90, -365, -366, -6000]) {
      insert.run("usdt-tether", now + offset * day, offset === -6000 ? 0 : 100, offset === -6000 ? null : 1);
    }
    insert.run("usdc-circle", now - 6001 * day, 999, 1);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(JSON.stringify({ snapshotDate: now }), now - 300);
    const response = await handleSupplyHistory(db, new URL(`https://x/api/supply-history?stablecoin=usdt-tether${query}`));
    expect(await readJsonResponse(response, 200)).toEqual(offsets.map((offset) => ({
      date: now + offset * day,
      circulatingUsd: offset === -6000 ? 0 : 100,
      price: offset === -6000 ? null : 1,
      supplyProvenance: null,
    })));
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(now));
    expect(response.headers.get("X-Data-Age")).toBe("0");
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
    );

    const res = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=5000"));

    expect(await readJsonResponse(res, 200)).toEqual([
      {
        date: row.snapshot_date,
        circulatingUsd: row.circulating_usd,
        price: row.price,
        supplyProvenance: null,
      },
    ]);
    db.assertAllMatchesUsed();
  });

  it.each([0, 3])("uses the coin observation even when the completed marker is newer (%s days)", async (days) => {
    const now = 1_800_000_000;
    const observedAt = now - days * 86_400 - 900;
    const snapshotDate = now - days * 86_400 - 1_800;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const provenance = { supplySource: "defillama", supplyObservedAt: observedAt, supplyChainGuard: null };
    sqlite.prepare(`INSERT INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, price, circulating_native,
       valuation_price_usd, valuation_observed_at_sec, supply_provenance)
      VALUES ('usdt-tether', ?, 0, 2, 0, 1, ?, ?)`).run(snapshotDate, observedAt, JSON.stringify(provenance));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)")
      .run(JSON.stringify({ snapshotDate: now - 60 }), now - 60);
    const response = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    expect(response.headers.get("X-Data-Updated-At")).toBe(String(observedAt));
    expect(response.headers.get("X-Data-Age")).toBe(String(now - observedAt));
    expect(await readJsonResponse(response, 200)).toEqual([{
      date: snapshotDate, circulatingUsd: 0, price: 2, circulatingNative: 0,
      valuationPriceUsd: 1, valuationObservedAtSec: observedAt, supplyProvenance: provenance,
    }]);
  });

  it("fences completed publication inclusively and returns chronological history", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES ('usdt-tether', ?, ?, 1)");
    for (const offset of [-10, 1, 0]) insert.run(now + offset, 100 + offset);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)").run(JSON.stringify({ snapshotDate: now }), now);
    expect(await readJsonResponse(await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether")), 200)).toEqual([
      { date: now - 10, circulatingUsd: 90, price: 1, supplyProvenance: null },
      { date: now, circulatingUsd: 100, price: 1, supplyProvenance: null },
    ]);
  });

  it.each(["kau-kinesis", "kag-kinesis"])("switches %s from program to wrapper only on its own cutover", async (id) => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance)
      VALUES (?, ?, ?, ?, ?)`);
    insert.run(id, now - 2 * 86_400, 500_000_000, null, null);
    const provenance = { supplySource: "onchain-total-supply", supplyObservedAt: now - 100, supplyChainGuard: null };
    insert.run(id, now - 86_400, 220_000_000, 1_640_000, JSON.stringify(provenance));
    const url = new URL(`https://x/api/supply-history?stablecoin=${id}`);
    const before = await handleSupplyHistory(db, url, null);
    expect(await readJsonResponse(before, 200)).toEqual([{ date: now - 2 * 86_400,
      circulatingUsd: 500_000_000, price: null, supplyProvenance: null }]);
    vi.spyOn(perimeters, "isKinesisWrapperSupplyCutoverActive").mockImplementation((asset, at) => asset === id && at >= now - 86_400);
    const response = await handleSupplyHistory(db, url, null);
    expect(await readJsonResponse(response, 200)).toEqual([{
      date: now - 86_400, circulatingUsd: 220_000_000, circulatingNative: 1_640_000, price: null,
      supplyProvenance: provenance,
    }]);
  });

  it("publishes recorded, partial, legacy and malformed provenance per row without touching supply (K-031)", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const partialGuard = makeChainGapGuard(true);
    const complete = { supplySource: "defillama", supplyObservedAt: null, supplyChainGuard: null };
    const partial = { supplySource: "defillama", supplyObservedAt: now - 3 * 86_400 - 120, supplyChainGuard: partialGuard };
    const insert = sqlite.prepare(
      "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, supply_provenance) VALUES ('usdt-tether', ?, ?, ?, ?)",
    );
    insert.run(now - 4 * 86_400, 100_000, 1, null);
    insert.run(now - 3 * 86_400, 97_000, 1, JSON.stringify(partial));
    insert.run(now - 2 * 86_400, 99_000, null, "{broken");
    insert.run(now - 86_400, 100_000, 1, JSON.stringify(complete));
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('snapshot-supply:last-write', ?, ?)")
      .run(JSON.stringify({ snapshotDate: now - 86_400 }), now - 3_600);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await handleSupplyHistory(db, new URL("https://x/api/supply-history?stablecoin=usdt-tether"));
    expect(await readJsonResponse(response, 200)).toEqual([
      { date: now - 4 * 86_400, circulatingUsd: 100_000, price: 1, supplyProvenance: null },
      { date: now - 3 * 86_400, circulatingUsd: 97_000, price: 1, supplyProvenance: partial },
      { date: now - 2 * 86_400, circulatingUsd: 99_000, price: null, supplyProvenance: null },
      { date: now - 86_400, circulatingUsd: 100_000, price: 1, supplyProvenance: complete },
    ]);
    // The newest legacy observation uses its date when its precise clock is absent.
    expect(response.headers.get("X-Data-Age")).toBe("86400");
    warn.mockRestore();
  });

  it("uses the newest markerless row for freshness and leaves empty history unfreshened", async () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { db, sqlite } = fixtures.open();
    const url = new URL("https://x/api/supply-history?stablecoin=usdt-tether");
    const empty = await handleSupplyHistory(db, url);
    expect(await readJsonResponse(empty, 200)).toEqual([]);
    expect(empty.headers.get("X-Data-Age")).toBe("unavailable");
    expect(empty.headers.get("X-Data-Updated-At")).toBe("unknown");
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    expect(empty.headers.get("X-Data-Freshness-Reason")).toBe("missing-timestamp");
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES ('usdt-tether', ?, 10, 1), ('usdt-tether', ?, 20, 1)").run(now - 30, now - 300);
    const populated = await handleSupplyHistory(db, url);
    expect(populated.headers.get("X-Data-Age")).toBe("30");
    expect(await readJsonResponse(populated, 200)).toEqual([
      { date: now - 300, circulatingUsd: 20, price: 1, supplyProvenance: null },
      { date: now - 30, circulatingUsd: 10, price: 1, supplyProvenance: null },
    ]);
  });
});

registerStablecoinParameterContract({
  name: "supply history",
  path: "/api/supply-history",
  invoke: handleSupplyHistory,
});
