import { describe, it, expect } from "vitest";
import { mockD1, type MockD1Database } from "./helpers/mock-d1";
import { makeMintBurnRow } from "./helpers/fixtures";
import { handleMintBurnEvents } from "../mint-burn-events";

describe("handleMintBurnEvents", () => {
  const row = makeMintBurnRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
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

  it("returns 400 when stablecoin param is missing", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events"));
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=<script>"));
    expect(res.status).toBe(404);
  });

  it("rejects invalid direction with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&direction=delete"));
    expect(res.status).toBe(400);
  });

  it("rejects non-ethereum chain filter with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=usdt-tether&chain=base"));
    expect(res.status).toBe(400);
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ burnType: string | null }> };
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ flowType: string }> };
    expect(body.events[0]?.flowType).toBe("atomic_roundtrip");
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
