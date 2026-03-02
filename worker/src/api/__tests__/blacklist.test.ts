import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeBlacklistRow } from "./helpers/fixtures";
import { handleBlacklist } from "../blacklist";

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();

  it("returns 200 with events and total", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("maps snake_case DB columns to camelCase", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const body = (await res.json()) as { events: Array<Record<string, unknown>> };
    const event = body.events[0];
    expect(event).toHaveProperty("chainId");
    expect(event).toHaveProperty("chainName");
    expect(event).toHaveProperty("eventType");
    expect(event).toHaveProperty("txHash");
    expect(event).toHaveProperty("blockNumber");
    expect(event).toHaveProperty("explorerTxUrl");
    expect(event).toHaveProperty("explorerAddressUrl");
    // Should NOT have snake_case keys
    expect(event).not.toHaveProperty("chain_id");
    expect(event).not.toHaveProperty("event_type");
  });

  it("returns 200 with empty results when no data", async () => {
    const emptyDb = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleBlacklist(emptyDb, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("rejects invalid stablecoin ID with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=<script>"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid chain parameter with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chain=InvalidChain"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid eventType with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?eventType=hack"));
    expect(res.status).toBe(400);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });
});
