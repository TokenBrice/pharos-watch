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

  it("includes methodology version metadata", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const body = (await res.json()) as { methodology: Record<string, unknown> };
    expect(body.methodology).toHaveProperty("version");
    expect(body.methodology).toHaveProperty("versionLabel");
    expect(body.methodology).toHaveProperty("changelogPath");
  });

  it("derives response methodology from latest returned event", async () => {
    const historicalRow = makeBlacklistRow({
      timestamp: 1771000000,
      methodology_version: "2.0",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [historicalRow] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const body = (await res.json()) as { methodology: { version: string; isCurrent: boolean } };
    expect(body.methodology.version).toBe("2.0");
    expect(body.methodology.isCurrent).toBe(false);
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
    expect(event).toHaveProperty("methodologyVersion");
    // Should NOT have snake_case keys
    expect(event).not.toHaveProperty("chain_id");
    expect(event).not.toHaveProperty("event_type");
    expect(event).not.toHaveProperty("methodology_version");
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

  it("accepts valid stablecoin symbol filters", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=usdt"));
    expect(res.status).toBe(200);
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

  it("derives freshness from sync-blacklist cron timestamp", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [makeBlacklistRow({ timestamp: now - 14 * 86400 })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 30 } },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });
});
