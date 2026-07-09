import { describe, it, expect } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeBlacklistRow } from "../../test-helpers/__shared/fixtures";
import { handleBlacklist } from "../blacklist";

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();

  function makeDbWithDataBindCapture(capture: (args: unknown[]) => void): D1Database {
    const stmt = (sql: string) => ({
      bind: (...args: unknown[]) => {
        if (sql.includes("FROM blacklist_events") && !sql.includes("COUNT(")) {
          capture(args);
        }
        return {
          all: async <T>() => ({
            results: (sql.includes("COUNT") ? [{ total: 0 }] : []) as T[],
            success: true,
            meta: {},
          }),
          first: async <T>() => null as T | null,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => null as T | null,
      run: async () => ({ success: true, meta: {} }),
    });

    return {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: { all: () => Promise<unknown> }[]) => {
        const results = [];
        for (const statement of stmts) {
          results.push(await statement.all());
        }
        return results as unknown[];
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;
  }

  it("returns an inexact lower-bound total by default without running COUNT(*)", async () => {
    const db = mockD1([
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; total: number; totalExact: boolean };
    expect(body.events).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(false);
    expect(db.getHistory().some((entry) => entry.sql.includes("COUNT(*)"))).toBe(false);
  });

  it("runs the exact count only when includeTotal=true", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 42 }] },
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?includeTotal=true"));
    const body = (await res.json()) as { total: number; totalExact: boolean };
    expect(body.total).toBe(42);
    expect(body.totalExact).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("COUNT(*)"))).toBe(true);
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

  it("derives response methodology from the latest returned event independent of sort order", async () => {
    const historicalRow = makeBlacklistRow({
      timestamp: 1771000000,
      methodology_version: "2.0",
    });
    const newerRow = makeBlacklistRow({
      id: "newer-methodology",
      stablecoin: "USDT",
      timestamp: 1772000000,
      methodology_version: "3.0",
    });
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 2 }] },
      { match: "blacklist_events", rows: [historicalRow, newerRow] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?sortBy=stablecoin&sortDirection=asc"));
    const body = (await res.json()) as { methodology: { version: string; isCurrent: boolean } };
    expect(body.methodology.version).toBe("3.0");
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
    expect(event).toHaveProperty("amountNative");
    expect(event).toHaveProperty("amountUsdAtEvent");
    expect(event).toHaveProperty("amountSource");
    expect(event).toHaveProperty("amountStatus");
    expect(event).toHaveProperty("contractAddress");
    expect(event).toHaveProperty("configKey");
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

  it("accepts first-wave stablecoin symbol filters", async () => {
    for (const symbol of ["usdg", "rlusd", "u", "usdtb", "a7a5", "fdusd", "brz", "ausd", "euri", "usdq", "usdo", "usdx", "aid", "tgbp", "mnee", "eurc", "buidl"]) {
      const db = mockD1([
        { match: "COUNT", rows: [{ total: 0 }] },
        { match: "blacklist_events", rows: [] },
      ]);
      const res = await handleBlacklist(db, new URL(`https://x/api/blacklist?stablecoin=${symbol}`));
      expect(res.status, symbol).toBe(200);
    }
  });

  it("accepts EURC stablecoin filter after mirror-zero suppression support", async () => {
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 0 }] },
      { match: "blacklist_events", rows: [] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=eurc"));
    expect(res.status).toBe(200);
  });

  it("normalizes stablecoin filters before binding", async () => {
    let dataBinds: unknown[] = [];
    const db = makeDbWithDataBindCapture((args) => {
      dataBinds = args;
    });

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=usdt"));
    expect(res.status).toBe(200);
    expect(dataBinds).toContain("USDT");
    expect(dataBinds).not.toContain("usdt");
  });

  it("rejects invalid chain parameter with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chain=InvalidChain"));
    expect(res.status).toBe(400);
  });

  it("accepts chainId filters and normalizes them before binding", async () => {
    let dataBinds: unknown[] = [];
    const db = makeDbWithDataBindCapture((args) => {
      dataBinds = args;
    });

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chainId=Ethereum"));
    expect(res.status).toBe(200);
    expect(dataBinds).toContain("ethereum");
    expect(dataBinds).not.toContain("Ethereum");
  });

  it("rejects invalid chainId parameter with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chainId=unknown-chain"));
    expect(res.status).toBe(400);
  });

  it("rejects known chainIds outside blacklist tracker coverage", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chainId=fantom"));
    expect(res.status).toBe(400);
  });

  it("rejects mismatched chain and chainId parameters", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chain=Tron&chainId=ethereum"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid eventType with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?eventType=hack"));
    expect(res.status).toBe(400);
  });

  it("accepts valid eventType filters before pagination", async () => {
    let dataBinds: unknown[] = [];
    const db = makeDbWithDataBindCapture((args) => {
      dataBinds = args;
    });

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?eventType=destroy"));
    expect(res.status).toBe(200);
    expect(dataBinds).toContain("destroy");
  });

  it("rejects invalid sortBy with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?sortBy=amount"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid sortDirection with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?sortDirection=sideways"));
    expect(res.status).toBe(400);
  });

  it("binds address search filters case-insensitively", async () => {
    let dataBinds: unknown[] = [];
    const db = makeDbWithDataBindCapture((args) => {
      dataBinds = args;
    });

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?q=0xAbC"));
    expect(res.status).toBe(200);
    expect(dataBinds).toContain("%0xabc%");
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
    const eventTs = now - 14 * 86400;
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [makeBlacklistRow({ timestamp: eventTs })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 30 } },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const age = Number(res.headers.get("X-Data-Age"));
    const body = await res.json() as { methodology: { asOf: number } };
    expect(age).toBeLessThan(120);
    expect(body.methodology.asOf).toBe(eventTs);
  });

  it("falls back to latest event timestamp when sync-blacklist has no successful cron row", async () => {
    const now = Math.floor(Date.now() / 1000);
    const eventTs = now - 3600;
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [makeBlacklistRow({ timestamp: eventTs })] },
      { match: "cron_runs", rows: [], first: { started_at: null } },
    ]);

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeGreaterThanOrEqual(3600);
    expect(age).toBeLessThan(3700);
  });

  it("rejects oversized limit values instead of silently clamping them", async () => {
    const res = await handleBlacklist(mockD1([]), new URL("https://x/api/blacklist?limit=999999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 0 and 1000" });
  });

  it("maps limit=0 to default limit 1000", async () => {
    let dataBinds: unknown[] = [];
    const db = makeDbWithDataBindCapture((args) => {
      dataBinds = args;
    });

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?limit=0"));
    expect(res.status).toBe(200);
    // Cursor-capable feeds request one look-ahead row to decide nextCursor.
    expect(dataBinds).toContain(1001);
  });

  it("caps legacy offset pagination and accepts the maximum supported offset", async () => {
    const rejected = await handleBlacklist(mockD1([]), new URL("https://x/api/blacklist?offset=25001"));
    expect(rejected.status).toBe(400);

    let dataBinds: unknown[] = [];
    const accepted = await handleBlacklist(
      makeDbWithDataBindCapture((args) => { dataBinds = args; }),
      new URL("https://x/api/blacklist?offset=25000"),
    );
    expect(accepted.status).toBe(200);
    expect(dataBinds).toContain(25_000);
  });

  it("uses keyset cursor bindings for the selected sort order", async () => {
    const firstDb = mockD1([
      { match: "blacklist_events", rows: [
        makeBlacklistRow({ id: "b", stablecoin: "USDT", timestamp: 200 }),
        makeBlacklistRow({ id: "a", stablecoin: "USDT", timestamp: 100 }),
      ] },
    ]);
    const first = await handleBlacklist(
      firstDb,
      new URL("https://x/api/blacklist?limit=1&sortBy=stablecoin&sortDirection=asc"),
    );
    const firstBody = await first.json() as { nextCursor: string | null };
    expect(firstBody.nextCursor).toBeTruthy();

    const nextDb = mockD1([{ match: "blacklist_events", rows: [] }]);
    const next = await handleBlacklist(
      nextDb,
      new URL(`https://x/api/blacklist?limit=1&sortBy=stablecoin&sortDirection=asc&cursor=${firstBody.nextCursor}`),
    );
    expect(next.status).toBe(200);
    const query = nextDb.getHistory().find((entry) => entry.sql.includes("pharos:blacklist-events:page"));
    expect(query?.sql).toContain("stablecoin > ?");
    expect(query?.sql).toContain("stablecoin = ? AND timestamp < ?");
    expect(query?.binds.slice(0, 6)).toEqual(["USDT", "USDT", 200, "USDT", 200, "b"]);
  });

  it("uses timestamp and id keyset bindings for the default date sort", async () => {
    const firstDb = mockD1([
      { match: "blacklist_events", rows: [
        makeBlacklistRow({ id: "newer", timestamp: 200 }),
        makeBlacklistRow({ id: "older", timestamp: 100 }),
      ] },
    ]);
    const first = await handleBlacklist(
      firstDb,
      new URL("https://x/api/blacklist?limit=1"),
    );
    const firstBody = await first.json() as { nextCursor: string | null };
    expect(firstBody.nextCursor).toBeTruthy();

    const nextDb = mockD1([{ match: "blacklist_events", rows: [] }]);
    const next = await handleBlacklist(
      nextDb,
      new URL(`https://x/api/blacklist?limit=1&cursor=${firstBody.nextCursor}`),
    );
    expect(next.status).toBe(200);
    const query = nextDb.getHistory().find((entry) => entry.sql.includes("pharos:blacklist-events:page"));
    expect(query?.sql).toContain("timestamp < ?");
    expect(query?.sql).toContain("timestamp = ? AND id < ?");
    expect(query?.binds.slice(0, 3)).toEqual([200, 200, "newer"]);
  });
});
