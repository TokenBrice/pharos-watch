import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockCircuitBreaker, mockFetchRetry } from "../../test-helpers/cron";

const { logWorkerEventMock } = vi.hoisted(() => ({
  logWorkerEventMock: vi.fn(),
}));

vi.mock("@shared/lib/stablecoins/registry", () => ({
  TRACKED_STABLECOINS: [
    { id: "usdt-tether", geckoId: "tether" },
    { id: "usdc-circle", geckoId: "usd-coin" },
    { id: "benji-franklin-templeton", geckoId: "franklin-benji-tokenized-us-government-money-fund", status: "quarantined" },
  ],
}));

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());

vi.mock("../../lib/structured-log", () => ({
  logWorkerEvent: logWorkerEventMock,
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
    const cgCoins = [{ id: "no-mcap", name: "NoMcap", symbol: "NM", market_cap: null }];
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

  it("filters durable listing exclusions even when they are no longer active", () => {
    const cgCoins = [
      { id: "bfusd", name: "BFUSD", symbol: "BFUSD", market_cap: 100_000_000 },
      { id: "new-stable", name: "NewStable", symbol: "NST", market_cap: 10_000_000 },
    ];
    const result = filterDiscoveryCandidates(cgCoins, TRACKED_GECKO_IDS, 5_000_000);
    expect(result.map((candidate) => candidate.geckoId)).toEqual(["new-stable"]);
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
    expect(history[0].sql).toContain("ON CONFLICT (gecko_id) WHERE gecko_id IS NOT NULL");
    expect(history[1].sql).toContain("ON CONFLICT (llama_id) WHERE llama_id IS NOT NULL");
  });

  it("rejects malformed candidates before D1 while preserving valid candidates", async () => {
    const db = mockD1();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-24T12:00:00Z"));
    try {
      const upserted = await upsertDiscoveryCandidates(db, [
        { geckoId: "good-one", name: "GoodOne", symbol: "GOOD", marketCap: 10_000_000, source: "coingecko" },
        {
          geckoId: "bad-stable",
          name: null as unknown as string,
          symbol: "BAD",
          marketCap: 9_000_000,
          source: "coingecko",
        },
        { llamaId: 42, name: "LlamaStable", symbol: "LST", marketCap: 8_000_000, source: "defillama" },
      ]);

      expect(upserted).toBe(2);
      expect(logWorkerEventMock).toHaveBeenCalledWith(expect.objectContaining({
        event: "discovery_candidate_rejected",
        level: "warn",
        metadata: { geckoId: "bad-stable", llamaId: null },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist an excluded provider ID from any discovery source", async () => {
    const db = mockD1();
    const upserted = await upsertDiscoveryCandidates(db, [
      { geckoId: "bfusd", name: "BFUSD", symbol: "BFUSD", marketCap: 100_000_000, source: "coingecko" },
    ]);
    expect(upserted).toBe(0);
    expect(db.getHistory()).toHaveLength(0);
  });
});

describe("runDiscoveryScan", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00Z")); // Monday
    vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
    logWorkerEventMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a neutral skipped result outside Monday UTC", async () => {
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z")); // Tuesday
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("skipped_neutral");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "not-monday",
      skipped: "not-monday",
      utcDay: 2,
    });
    expect(shouldAttemptFetch).not.toHaveBeenCalled();
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

  it("does not rediscover a quarantined catalog row", async () => {
    mockFetch([{
      match: "coins/markets",
      body: [
        {
          id: "franklin-benji-tokenized-us-government-money-fund",
          name: "Franklin OnChain U.S. Government Money Fund",
          symbol: "benji",
          market_cap: 500_000_000,
        },
        { id: "new-stable", name: "New Stable", symbol: "nst", market_cap: 9_000_000 },
      ],
    }]);
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);
    expect(db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO discovery_candidates")))
      .toHaveLength(1);
  });

  it("returns degraded when a successful upstream response violates the array contract", async () => {
    mockFetch([{ match: "coins/markets", body: { data: [] } }]);
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "invalid-payload",
      cgFetched: false,
      persistenceAttempted: 0,
    });
    expect(logWorkerEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event: "discovery_payload_invalid",
      provider: "coingecko",
    }));
  });

  it("persists valid rows but degrades when the upstream array contains malformed rows", async () => {
    mockFetch([
      {
        match: "coins/markets",
        body: [
          { id: "new-stable", name: "New Stable", symbol: "nst", market_cap: 9_000_000 },
          { id: "broken", name: "Broken", symbol: 42, market_cap: 8_000_000 },
        ],
      },
    ]);
    const db = mockD1();

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "malformed-source-rows",
      cgCandidates: 1,
      cgInvalidRows: 1,
      persistencePersisted: 1,
      persistenceFailed: 0,
    });
  });

  it("reports degraded partial persistence when an individual fallback upsert fails", async () => {
    mockFetch([
      {
        match: "coins/markets",
        body: [
          { id: "good-stable", name: "Good Stable", symbol: "good", market_cap: 10_000_000 },
          { id: "bad-stable", name: "Bad Stable", symbol: "bad", market_cap: 9_000_000 },
        ],
      },
    ]);
    const db = mockD1([
      {
        match: "INSERT INTO discovery_candidates",
        matchBinds: [
          "bad-stable",
          null,
          "Bad Stable",
          "BAD",
          9_000_000,
          "coingecko",
          1_774_267_200,
          1_774_267_200,
        ],
        rows: [],
        throwError: new Error("D1 write rejected"),
      },
    ]);

    const result = await runDiscoveryScan(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "partial-persistence",
      persistenceAttempted: 2,
      persistencePersisted: 1,
      persistenceFailed: 1,
    });
  });
});
