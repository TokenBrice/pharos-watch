import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1Preset, findD1HistoryEntry, type MockD1Database } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";
import { recordOutcomeSafe } from "../../lib/circuit-breaker";

vi.mock("@shared/lib/bluechip-slugs", () => ({
  BLUECHIP_SLUG_MAP: {
    tether: "usdt-tether",
    usdc: "usdc-circle",
  },
}));

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

vi.mock("../../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: vi.fn(async () => true),
    recordOutcomeSafe: vi.fn(async () => undefined),
  };
});

import { syncBluechip } from "../sync-bluechip";

const mockD1 = createMockD1Preset([
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "INSERT INTO cache", rows: [] },
]);

const getCacheInsert = (db: MockD1Database) => findD1HistoryEntry(db, "INSERT INTO cache", [0, "bluechip-ratings"]);

describe("syncBluechip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes transformed bluechip ratings to cache on happy path", async () => {
    mockFetch([
      {
        match: "/coin-data/tether",
        body: {
          data: [
            {
              grade: "A",
              collateralization: 95,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: "2026-02-15",
              stability: { translations: [{ summary: "<p>stable</p>" }] },
            },
          ],
        },
      },
      {
        match: "/coin-data/usdc",
        body: {
          data: [
            {
              grade: "B",
              collateralization: 88,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: null,
              management: { translations: [{ summary: "<p>managed</p>" }] },
            },
          ],
        },
      },
    ]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(2);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      ratingsFetched: number;
      failedSlugs?: unknown;
    };
    expect(metadata.ratingsFetched).toBe(2);
    expect(metadata.failedSlugs).toBeUndefined();

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    const cached = JSON.parse(String(insert?.binds[1])) as Record<
      string,
      { grade: string; slug: string; smidge: Record<string, string | null> }
    >;
    expect(cached["usdt-tether"].grade).toBe("A");
    expect(cached["usdt-tether"].slug).toBe("tether");
    expect(cached["usdt-tether"].smidge.stability).toBe("stable");
    expect(cached["usdc-circle"].grade).toBe("B");
    expect(cached["usdc-circle"].slug).toBe("usdc");
  });

  it("accepts null category blocks from the Bluechip payload", async () => {
    mockFetch([
      {
        match: "/coin-data/tether",
        body: {
          data: [
            {
              grade: "A",
              collateralization: 95,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: "2026-02-15",
              implementation: null,
              externals: null,
            },
          ],
        },
      },
      {
        match: "/coin-data/usdc",
        body: {
          data: [
            {
              grade: "B+",
              collateralization: 100,
              smart_contract_audit: true,
              date_of_rating: "2026-03-24",
              date_last_change: null,
              implementation: null,
              externals: null,
              management: { translations: [{ summary: "<p>managed</p>" }] },
            },
          ],
        },
      },
    ]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(2);

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Record<
      string,
      { grade: string; smidge: Record<string, string | null> }
    >;
    expect(cached["usdc-circle"].grade).toBe("B+");
    expect(cached["usdc-circle"].smidge.implementation).toBeNull();
    expect(cached["usdc-circle"].smidge.externals).toBeNull();
  });

  it("accepts null date_of_rating values from the Bluechip payload", async () => {
    mockFetch([
      {
        match: "/coin-data/tether",
        body: {
          data: [
            {
              grade: "A",
              collateralization: 95,
              smart_contract_audit: true,
              date_of_rating: null,
              date_last_change: "2026-02-15",
            },
          ],
        },
      },
      {
        match: "/coin-data/usdc",
        body: {
          data: [
            {
              grade: "B+",
              collateralization: 100,
              smart_contract_audit: true,
              date_of_rating: null,
              date_last_change: null,
            },
          ],
        },
      },
    ]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(2);

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Record<string, { dateOfRating: string }>;
    expect(cached["usdt-tether"].dateOfRating).toBe("");
    expect(cached["usdc-circle"].dateOfRating).toBe("");
  });

  it("returns degraded when bluechip API requests fail", async () => {
    const tetherResponse = new Response(JSON.stringify({ error: "down" }), { status: 500 });
    const usdcResponse = new Response(JSON.stringify({ error: "down" }), { status: 500 });
    const tetherCancel = vi.spyOn(tetherResponse.body!, "cancel");
    const usdcCancel = vi.spyOn(usdcResponse.body!, "cancel");
    mockFetch([{ match: () => true, respond: (request) =>
      request.url.includes("/coin-data/tether") ? tetherResponse : usdcResponse }]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      failedSlugs: { slug: string; reason: string }[];
    };
    expect(metadata.reason).toBe("upstream-no-ratings");
    expect(metadata.failedSlugs).toEqual([
      { slug: "tether", reason: "http-500" },
      { slug: "usdc", reason: "http-500" },
    ]);
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
    expect(tetherCancel).toHaveBeenCalledOnce();
    expect(usdcCancel).toHaveBeenCalledOnce();
  });

  it("merges fresh ratings into the existing cache when only a subset of slugs succeeds", async () => {
    mockFetch([
      {
        match: "/coin-data/tether",
        body: {
          data: [
            {
              grade: "A",
              collateralization: 95,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: "2026-02-15",
            },
          ],
        },
      },
      {
        match: "/coin-data/usdc",
        body: { error: "down" },
        status: 500,
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["bluechip-ratings"],
        rows: [],
        first: {
          value: JSON.stringify({
            "usdc-circle": {
              grade: "B",
              slug: "usdc",
              collateralization: 88,
              smartContractAudit: true,
              dateOfRating: "2026-02-20",
              dateLastChange: null,
              smidge: {
                stability: null,
                management: "managed",
                implementation: null,
                decentralization: null,
                governance: null,
                externals: null,
              },
            },
          }),
          updated_at: Math.floor(Date.now() / 1000) - 30_000,
        },
      },
    ]);

    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      ratingsFetched: number;
      ratingsPublished: number;
      fallbackMode: string | null;
      failedSlugs: { slug: string; reason: string }[];
    };
    expect(metadata.ratingsFetched).toBe(1);
    expect(metadata.ratingsPublished).toBe(2);
    expect(metadata.fallbackMode).toBe("partial-cache-merge");
    expect(metadata.failedSlugs).toEqual([{ slug: "usdc", reason: "http-500" }]);
    expect(recordOutcomeSafe).toHaveBeenCalledWith(db, "bluechip-api", true);

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Record<string, { grade: string }>;
    expect(cached["usdt-tether"]?.grade).toBe("A");
    expect(cached["usdc-circle"]?.grade).toBe("B");
  });

  it("ignores malformed existing cache entries when partial coverage is published", async () => {
    mockFetch([
      {
        match: "/coin-data/tether",
        body: {
          data: [
            {
              grade: "A",
              collateralization: 95,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: "2026-02-15",
            },
          ],
        },
      },
      {
        match: "/coin-data/usdc",
        body: { error: "down" },
        status: 500,
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["bluechip-ratings"],
        rows: [],
        first: {
          value: JSON.stringify({
            "usdc-circle": {
              grade: "B",
            },
          }),
          updated_at: Math.floor(Date.now() / 1000) - 30_000,
        },
      },
    ]);

    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      ratingsFetched: number;
      ratingsPublished: number;
      retainedFromCache: number;
    };
    expect(metadata.ratingsFetched).toBe(1);
    expect(metadata.ratingsPublished).toBe(1);
    expect(metadata.retainedFromCache).toBe(0);

    const insert = getCacheInsert(db as MockD1Database);
    const cached = JSON.parse(String(insert?.binds[1])) as Record<string, { grade: string }>;
    expect(cached).toEqual({
      "usdt-tether": expect.objectContaining({ grade: "A" }),
    });
  });

  it("records json parse failures per slug without losing partial coverage", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      {
        match: "/coin-data/tether",
        body: "<html>bad gateway</html>",
        status: 200,
        headers: { "content-type": "text/html" },
      },
      {
        match: "/coin-data/usdc",
        body: {
          data: [
            {
              grade: "B",
              collateralization: 88,
              smart_contract_audit: true,
              date_of_rating: "2026-03-01",
              date_last_change: null,
            },
          ],
        },
      },
    ]);

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["bluechip-ratings"],
        rows: [],
        first: {
          value: JSON.stringify({
            "usdt-tether": {
              grade: "A",
              slug: "tether",
              collateralization: 95,
              smartContractAudit: true,
              dateOfRating: "2026-02-20",
              dateLastChange: null,
              smidge: {
                stability: null,
                management: null,
                implementation: null,
                decentralization: null,
                governance: null,
                externals: null,
              },
            },
          }),
          updated_at: Math.floor(Date.now() / 1000) - 30_000,
        },
      },
    ]);

    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      invalidPayloads: number;
      failedSlugs: { slug: string; reason: string }[];
    };
    expect(metadata.invalidPayloads).toBe(1);
    expect(metadata.failedSlugs).toEqual([{ slug: "tether", reason: "json-parse-failed" }]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[bluechip] Failed to parse JSON for tether:"));
  });

  it("returns degraded on invalid response shape", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      {
        match: "/coin-data/tether",
        body: { data: [{ collateralization: 99 }] },
      },
      {
        match: "/coin-data/usdc",
        body: { data: [] },
      },
    ]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      failedSlugs: { slug: string; reason: string }[];
    };
    expect(metadata.reason).toBe("upstream-no-ratings");
    expect(metadata.failedSlugs).toEqual([
      { slug: "tether", reason: "invalid-payload" },
      { slug: "usdc", reason: "empty-data" },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[bluechip] No ratings fetched, preserving cache"));
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });
});
