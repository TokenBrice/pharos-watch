import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeMintBurnRow } from "./helpers/fixtures";
import { handleMintBurnEvents } from "../mint-burn-events";

describe("handleMintBurnEvents", () => {
  const row = makeMintBurnRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=1"));
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
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=1"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("stablecoinId");
    expect(event).toHaveProperty("chainId");
    expect(event).toHaveProperty("amountUsd");
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

  it("returns 400 for invalid stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=<script>"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid direction with 400", async () => {
    const db = mockD1([]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=1&direction=delete"));
    expect(res.status).toBe(400);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "mint_burn_events", rows: [row] },
    ]);
    const res = await handleMintBurnEvents(db, new URL("https://x/api/mint-burn-events?stablecoin=1"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
