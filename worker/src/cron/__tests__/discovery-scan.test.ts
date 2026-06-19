import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_STABLECOINS: [
    { id: "usdt-tether", geckoId: "tether" },
    { id: "usdc-circle", geckoId: "usd-coin" },
  ],
}));

vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
}));

vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { filterDiscoveryCandidates, runDiscoveryScan, upsertDiscoveryCandidates } from "../discovery-scan";

describe("filterDiscoveryCandidates", () => {
  const TRACKED_GECKO_IDS = new Set(["tether", "usd-coin", "dai"]);

  it("filters out already-tracked coins by geckoId", () => {
    const cgCoins = [
      { id: "tether", name: "Tether", symbol: "USDT", market_cap: 100_000_000_000 },
      { id: "new-stable", name: "NewStable", symbol: "NST", market_cap: 10_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(1);
    expect(result[0].geckoId).toBe("new-stable");
  });

  it("filters out coins below market cap threshold", () => {
    const cgCoins = [
      { id: "tiny-stable", name: "TinyStable", symbol: "TS", market_cap: 1_000_000 },
      { id: "big-stable", name: "BigStable", symbol: "BS", market_cap: 50_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(1);
    expect(result[0].geckoId).toBe("big-stable");
  });

  it("filters out coins with null market cap", () => {
    const cgCoins = [
      { id: "no-mcap", name: "NoMcap", symbol: "NM", market_cap: null },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(0);
  });

  it("returns empty when all coins are tracked", () => {
    const cgCoins = [
      { id: "tether", name: "Tether", symbol: "USDT", market_cap: 100_000_000_000 },
      { id: "usd-coin", name: "USD Coin", symbol: "USDC", market_cap: 50_000_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result).toHaveLength(0);
  });
});

describe("upsertDiscoveryCandidates", () => {
  it("returns 0 without touching the db for an empty candidate list", async () => {
    const db = mockD1();
    const upserted = await upsertDiscoveryCandidates(db, []);
    expect(upserted).toBe(0);
    expect(db.getHistory()).toHaveLength(0);
  });

  it("upserts candidates via a single batch and returns the change count", async () => {
    const db = mockD1();
    const upserted = await upsertDiscoveryCandidates(db, [
      { geckoId: "new-stable", name: "NewStable", symbol: "NST", marketCap: 10_000_000, source: "coingecko" },
      { llamaId: 42, name: "LlamaStable", symbol: "LST", marketCap: 8_000_000, source: "defillama" },
    ]);
    expect(upserted).toBe(2);

    const history = db.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].sql).toContain("ON CONFLICT (gecko_id)");
    expect(history[1].sql).toContain("ON CONFLICT (llama_id)");
  });

  it("falls back to per-candidate upserts when a discovery batch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1([
      {
        match: "INSERT INTO discovery_candidates",
        matchBinds: ["bad-stable", null, null, "BAD", 9_000_000, "coingecko", 1771934400, 1771934400],
        rows: [],
        throwError: new Error("NOT NULL constraint failed: discovery_candidates.name"),
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-24T12:00:00Z"));
    try {
      const upserted = await upsertDiscoveryCandidates(db, [
        { geckoId: "good-one", name: "GoodOne", symbol: "GOOD", marketCap: 10_000_000, source: "coingecko" },
        { geckoId: "bad-stable", name: null as unknown as string, symbol: "BAD", marketCap: 9_000_000, source: "coingecko" },
        { llamaId: 42, name: "LlamaStable", symbol: "LST", marketCap: 8_000_000, source: "defillama" },
      ]);

      expect(upserted).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        "[discovery] Upsert batch failed; retrying candidates individually:",
        expect.any(Error),
      );
      expect(warn).toHaveBeenCalledWith(
        "[discovery] Skipping discovery candidate after upsert failure:",
        expect.any(Error),
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe("runDiscoveryScan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z")); // Monday
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns degraded when the discovery circuit is open and no scan is attempted", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string; cgAllowed: boolean; cgFetched: boolean };
    expect(metadata.reason).toBe("circuit-open-no-attempt");
    expect(metadata.cgAllowed).toBe(false);
    expect(metadata.cgFetched).toBe(false);
  });

  it("returns degraded when the upstream fetch fails", async () => {
    mockFetch([
      {
        match: "coins/markets",
        body: { error: "down" },
        status: 500,
      },
    ]);
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("fetch-failed");
  });
});
