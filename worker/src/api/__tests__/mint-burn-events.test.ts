import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeMintBurnRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleMintBurnEvents } from "../mint-burn-events";

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

  it("uses counted scope to filter to standard economic-flow rows", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow()] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&scope=counted"),
    );

    expect(res.status).toBe(200);
    const countQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as total"));
    expect(countQuery?.sql).toContain("flow_type = 'standard'");
    expect(countQuery?.sql).toContain("(direction = 'mint' OR burn_type = 'effective_burn')");
  });

  it("treats minAmount as USD-only filtering", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [makeMintBurnRow()] },
    ]) as MockD1Database;

    const res = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&minAmount=1000000"),
    );

    expect(res.status).toBe(200);
    const countQuery = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as total"));
    expect(countQuery?.sql).toContain("amount_usd IS NOT NULL AND amount_usd >= ?");
    expect(countQuery?.sql).not.toContain("COALESCE(amount_usd, amount)");
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

  it("emits and accepts a keyset cursor", async () => {
    const first = makeMintBurnRow({ id: "mb-3", timestamp: 1_700_000_003, block_number: 103 });
    const second = makeMintBurnRow({ id: "mb-2", timestamp: 1_700_000_002, block_number: 102 });
    const db = mockD1([
      { match: "mint_burn_events", rows: [first, second] },
    ]) as MockD1Database;

    const firstRes = await handleMintBurnEvents(
      db,
      new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=1&includeTotal=false"),
    );
    const firstBody = (await firstRes.json()) as { nextCursor: string | null };
    expect(firstBody.nextCursor).toBeTypeOf("string");

    const cursorDb = mockD1([
      { match: "mint_burn_events", rows: [second] },
    ]) as MockD1Database;
    const cursorRes = await handleMintBurnEvents(
      cursorDb,
      new URL(`https://x/api/mint-burn-events?stablecoin=usdt-tether&limit=1&includeTotal=false&cursor=${firstBody.nextCursor}`),
    );

    expect(cursorRes.status).toBe(200);
    const dataQuery = cursorDb.getHistory().find((entry) => entry.sql.includes("FROM mint_burn_events"));
    expect(dataQuery?.sql).toContain("ORDER BY timestamp DESC, block_number DESC, id DESC");
    expect(dataQuery?.sql).toContain("timestamp < ?");
    expect(dataQuery?.sql).toContain("block_number < ?");
    expect(dataQuery?.sql).toContain("id < ?");
    expect(dataQuery?.sql).toContain("(timestamp = ? AND block_number = ? AND id < ?)");
    expect(dataQuery?.binds).toContain(first.timestamp);
    expect(dataQuery?.binds).toContain(first.block_number);
    expect(dataQuery?.binds).toContain(first.id);
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
