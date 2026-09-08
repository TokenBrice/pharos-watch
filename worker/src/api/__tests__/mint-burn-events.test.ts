import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleMintBurnEvents } from "../mint-burn-events";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function eventDb(rows: Record<string, string | number | null>[]) {
  const { sqlite, db } = fixtures.open();
  for (const row of rows) {
    sqlite.prepare(`INSERT INTO mint_burn_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  return db;
}

describe("handleMintBurnEvents", () => {
  const row = makeMintBurnRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("maps snake_case to camelCase", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("stablecoinId");
    expect(event).toHaveProperty("chainId");
    expect(event).toHaveProperty("amountUsd");
    expect(event).toHaveProperty("priceUsed");
    expect(event).toHaveProperty("priceTimestamp");
    expect(event).toHaveProperty("priceSource");
    expect(event).toHaveProperty("flowType");
    expect(event).toHaveProperty("burnType");
    expect(event).toHaveProperty("burnReviewReason");
    expect(event).toHaveProperty("txHash");
    expect(event).toHaveProperty("blockNumber");
    expect(event).toHaveProperty("explorerTxUrl");
    expect(event).not.toHaveProperty("stablecoin_id");
  });

  it("rejects invalid direction with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&direction=delete"));
    expect(res.status).toBe(400);
  });

  it("rejects chain filters outside the tracked scope for the requested stablecoin", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&chain=base"));
    expect(res.status).toBe(400);
  });

  it("accepts Arbitrum as the canonical USDai mint/burn chain", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow({ stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", symbol: "USDai" })] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdai-usd-ai&chain=arbitrum"),
    );

    expect(res.status).toBe(200);
    const countQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as total"));
    expect(countQuery?.sql).toContain("chain_id IN");
    expect(countQuery?.binds).toContain("arbitrum");
  });

  it("rejects invalid burnType with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&burnType=foo"));
    expect(res.status).toBe(400);
  });

  it("accepts valid bridge_burn filter", async () => {
    const bridgeRow = makeMintBurnRow({
      direction: "burn",
      burn_type: "bridge_burn",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [bridgeRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&burnType=bridge_burn"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ burnType: string | null }> };
    expect(body.events[0]?.burnType).toBe("bridge_burn");
  });

  it("maps flowType from snake_case and preserves atomic roundtrip rows", async () => {
    const atomicRow = makeMintBurnRow({
      direction: "burn",
      flow_type: "atomic_roundtrip",
      burn_type: "effective_burn",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [atomicRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ flowType: string }> };
    expect(body.events[0]?.flowType).toBe("atomic_roundtrip");
  });

  it("preserves bridge_transfer flow types for bridge noise rows", async () => {
    const bridgeRow = makeMintBurnRow({
      direction: "mint",
      flow_type: "bridge_transfer",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [bridgeRow] },
    ]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"),
    );
    const body = (await readJsonResponse(res, 200)) as { events: Array<{ flowType: string }> };
    expect(body.events[0]?.flowType).toBe("bridge_transfer");
  });

  it("rejects invalid scope with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&scope=debug"),
    );
    expect(res.status).toBe(400);
  });

  it.each([
    ["scope=counted", ["priced", "unpriced", "effective"]],
    ["minAmount=1000000", ["priced", "atomic", "bridge", "effective"]],
    ["scope=counted&minAmount=1000000", ["priced", "effective"]],
  ])("keeps count and selection aligned for %s", async (query, expected) => {
    const db = eventDb([
      makeMintBurnRow({ id: "priced", amount_usd: 1_000_000 }),
      makeMintBurnRow({ id: "unpriced", amount: 9_000_000, amount_usd: null }),
      makeMintBurnRow({ id: "atomic", amount_usd: 2_000_000, flow_type: "atomic_roundtrip" }),
      makeMintBurnRow({ id: "bridge", amount_usd: 2_000_000, direction: "burn", burn_type: "bridge_burn" }),
      makeMintBurnRow({ id: "effective", amount_usd: 2_000_000, direction: "burn", burn_type: "effective_burn" }),
      makeMintBurnRow({ id: "small", amount_usd: 999_999, flow_type: "bridge_transfer" }),
    ]);
    const body = await readJsonResponse<{ events: { id: string }[]; total: number }>(
      await handleMintBurnEvents(db, new URL(`https://x/api/mint-burn-events?stablecoin=usdt-tether&${query}`)), 200);
    expect(body.events.map((event) => event.id).sort()).toEqual([...expected].sort());
    expect(body.total).toBe(expected.length);
  });

  it("rejects malformed minAmount with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&minAmount=oops"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid minAmount: must be a number" });
  });

  it("rejects out-of-range limit values instead of clamping them", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=999"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 1 and 500" });
  });

  it("rejects offsets above the endpoint cap", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&offset=25001"),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid offset: must be between 0 and 25000" });
  });

  it("can skip exact total counts for cursor-style callers", async () => {
    const db = mockD1([
      { match: "mint_burn_events", rows: [row] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&includeTotal=false"),
    );

    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("COUNT(*) as total"))).toBe(false);
  });

  it("exhausts timestamp and block ties without losing cursor rows", async () => {
    const db = eventDb([
      makeMintBurnRow({ id: "mb-a", timestamp: 1_700_000_003, block_number: 103 }),
      makeMintBurnRow({ id: "mb-b", timestamp: 1_700_000_003, block_number: 103 }),
      makeMintBurnRow({ id: "mb-c", timestamp: 1_700_000_003, block_number: 102 }),
      makeMintBurnRow({ id: "mb-d", timestamp: 1_700_000_002, block_number: 101 }),
    ]);
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let page = 0; page < 4; page++) {
      const url = new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=1&includeTotal=false");
      if (cursor) url.searchParams.set("cursor", cursor);
      const body = await readJsonResponse<{ events: { id: string }[]; nextCursor: string | null }>(
        await handleMintBurnEvents(db, url), 200);
      ids.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
      expect(cursor === null).toBe(page === 3);
    }
    expect(ids).toEqual(["mb-b", "mb-a", "mb-c", "mb-d"]);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("uses sync-mint-burn cron timestamp for freshness metadata", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow({ timestamp: now - 10 * 86400 })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 20 } },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });
});

registerStablecoinParameterContract({
  name: "mint/burn events",
  path: "/api/mint-burn-events",
  invoke: handleMintBurnEvents,
  missingParameterError: "Missing required parameter: stablecoin",
});
