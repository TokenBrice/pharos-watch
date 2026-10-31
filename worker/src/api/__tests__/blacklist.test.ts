import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeBlacklistRow } from "../../test-helpers/__shared/fixtures";
import { handleBlacklist } from "../blacklist";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  vi.useRealTimers();
  fixtures.closeAll();
});

describe("handleBlacklist", () => {
  const row = makeBlacklistRow();

  it("returns an inexact lower-bound total by default without running COUNT(*)", async () => {
    const db = mockD1([
      { match: "blacklist_events", rows: [row] },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number; totalExact: boolean };
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
    const body = (await readJsonResponse(res, 200)) as { events: unknown[]; total: number };
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("rejects invalid stablecoin ID with 400", async () => {
    const db = mockD1([]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=<script>"));
    expect(res.status).toBe(400);
  });

  it("accepts first-wave stablecoin symbol filters", async () => {
    for (const symbol of ["usdg", "rlusd", "u", "usdtb", "a7a5", "fdusd", "brz", "ausd", "euri", "usdq", "usdo", "usdx", "aid", "tgbp", "eurc", "buidl"]) {
      const db = mockD1([
        { match: "COUNT", rows: [{ total: 0 }] },
        { match: "blacklist_events", rows: [] },
      ]);
      const res = await handleBlacklist(db, new URL(`https://x/api/blacklist?stablecoin=${symbol}`));
      expect(res.status, symbol).toBe(200);
    }
  });

  it("normalizes stablecoin filters before binding", async () => {
    const db = mockD1([{ match: "blacklist_events", rows: [] }]);

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?stablecoin=usdt"));
    const dataBinds = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events") && !entry.sql.includes("COUNT("))?.binds ?? [];
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
    const db = mockD1([{ match: "blacklist_events", rows: [] }]);

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?chainId=Ethereum"));
    const dataBinds = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events") && !entry.sql.includes("COUNT("))?.binds ?? [];
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
    const db = mockD1([{ match: "blacklist_events", rows: [] }]);

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?eventType=destroy"));
    const dataBinds = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events") && !entry.sql.includes("COUNT("))?.binds ?? [];
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

  it.each(["a".repeat(48), "a".repeat(49), "a".repeat(200), "a".repeat(201), "%", "_", "\\", "\u8cc7\u7523"])(
    "matches literal address substrings with no q length cap for %j", async (q) => {
      const { sqlite, db } = fixtures.open();
      const rows = [`before-${q.toUpperCase()}-after`, `before-${q}-after`, `before-${q.slice(0, -1)}-after`]
        .map((address, index) => makeBlacklistRow({
          id: `literal-${index}`, address, tx_hash: `tx-${index}`, timestamp: 1_700_000_000 + index,
        }));
      for (const row of rows) {
        const columns = Object.keys(row);
        sqlite.prepare(`INSERT INTO blacklist_events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .run(...Object.values(row));
      }
      const url = new URL("https://x/api/blacklist?includeTotal=true");
      url.searchParams.set("q", ` ${q.toUpperCase()} `);
      const body = await readJsonResponse<{ events: { id: string }[]; total: number; totalExact: boolean }>(
        await handleBlacklist(db, url), 200,
      );
      expect(body.events.map((event) => event.id)).toEqual(["literal-1", "literal-0"]);
      expect(body.total).toBe(2);
      expect(body.totalExact).toBe(true);

      url.searchParams.set("q", `${q.slice(0, -1)}!`);
      const missing = await readJsonResponse<{ events: unknown[]; total: number }>(await handleBlacklist(db, url), 200);
      expect(missing.events).toEqual([]);
      expect(missing.total).toBe(0);
    },
  );

  it("derives freshness from sync-blacklist cron timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const eventTs = now - 14 * 86400;
    const db = mockD1([
      { match: "COUNT", rows: [{ total: 1 }] },
      { match: "blacklist_events", rows: [makeBlacklistRow({ timestamp: eventTs })] },
      { match: "cron_runs", rows: [], first: { started_at: now - 30 } },
    ]);
    const res = await handleBlacklist(db, new URL("https://x/api/blacklist"));
    const age = res.headers.get("X-Data-Age");
    const body = await res.json() as { methodology: { asOf: number } };
    expect(age).toBe("30");
    expect(body.methodology.asOf).toBe(eventTs);
  });

  it("dates an empty page's methodology envelope from the confirmed producer output, never the request clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    // sync-blacklist's last confirmed output; the quiet filtered read observed nothing.
    const producerTs = now - 600;
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata)
      VALUES ('sync-blacklist', ?, 100, 'ok', ?)`)
      .run(producerTs, JSON.stringify({ outputPublishedAt: producerTs }));

    const res = await handleBlacklist(
      db,
      new URL("https://x/api/blacklist?stablecoin=AID&eventType=destroy"),
    );
    const body = await res.json() as {
      events: unknown[];
      methodology?: { asOf: number; isCurrent: boolean };
    };

    expect(body.events).toEqual([]);
    expect(res.headers.get("X-Data-Updated-At")).toBe(String(producerTs));
    // ADR-33/R6: the envelope's clock names the confirmed observation this read
    // was dated against, not the request second.
    expect(body.methodology?.asOf).toBe(producerTs);
  });


  it("rejects oversized limit values instead of silently clamping them", async () => {
    const res = await handleBlacklist(mockD1([]), new URL("https://x/api/blacklist?limit=999999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid limit: must be between 0 and 1000" });
  });

  it("maps limit=0 to default limit 1000", async () => {
    const db = mockD1([{ match: "blacklist_events", rows: [] }]);

    const res = await handleBlacklist(db, new URL("https://x/api/blacklist?limit=0"));
    const dataBinds = db.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events") && !entry.sql.includes("COUNT("))?.binds ?? [];
    expect(res.status).toBe(200);
    // Cursor-capable feeds request one look-ahead row to decide nextCursor.
    expect(dataBinds).toContain(1001);
  });

  it("caps legacy offset pagination and accepts the maximum supported offset", async () => {
    const rejected = await handleBlacklist(mockD1([]), new URL("https://x/api/blacklist?offset=25001"));
    expect(rejected.status).toBe(400);

    const acceptedDb = mockD1([{ match: "blacklist_events", rows: [] }]);
    const accepted = await handleBlacklist(
      acceptedDb,
      new URL("https://x/api/blacklist?offset=25000"),
    );
    const dataBinds = acceptedDb.getHistory().find((entry) => entry.sql.includes("FROM blacklist_events") && !entry.sql.includes("COUNT("))?.binds ?? [];
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
