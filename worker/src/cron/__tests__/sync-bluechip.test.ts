import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

vi.mock("../../lib/bluechip-slugs", () => ({
  BLUECHIP_SLUG_MAP: {
    tether: "usdt-tether",
    usdc: "usdc-circle",
  },
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

import { syncBluechip } from "../sync-bluechip";

function getCacheInsert(db: MockD1Database): { sql: string; binds: unknown[] } | undefined {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "bluechip-ratings");
}

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
    const metadata = JSON.parse(result.metadata ?? "{}") as { ratingsFetched: number };
    expect(metadata.ratingsFetched).toBe(2);

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    const cached = JSON.parse(String(insert?.binds[1])) as Record<string, { grade: string; slug: string; smidge: Record<string, string | null> }>;
    expect(cached["usdt-tether"].grade).toBe("A");
    expect(cached["usdt-tether"].slug).toBe("tether");
    expect(cached["usdt-tether"].smidge.stability).toBe("stable");
    expect(cached["usdc-circle"].grade).toBe("B");
    expect(cached["usdc-circle"].slug).toBe("usdc");
  });

  it("returns degraded when bluechip API requests fail", async () => {
    mockFetch([
      { match: "/coin-data/tether", body: { error: "down" }, status: 500 },
      { match: "/coin-data/usdc", body: { error: "down" }, status: 500 },
    ]);

    const db = mockD1();
    const result = await syncBluechip(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("upstream-no-ratings");
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
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
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("upstream-no-ratings");
    expect(warnSpy).toHaveBeenCalledWith("[bluechip] No ratings fetched, preserving cache");
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });
});
