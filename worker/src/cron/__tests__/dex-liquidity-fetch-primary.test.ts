import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

// Isolate the module under test from its heavy dependency tree
vi.mock("../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(async () => {}),
}));
vi.mock("../../lib/db-cache", () => ({ setCache: vi.fn(async () => {}) }));
vi.mock("../yield-sync/cache", () => ({ buildDlStablecoinPoolsCache: vi.fn(() => "{}") }));
vi.mock("../yield-sync/pool-filter", () => ({ isYieldRelevantDlPool: vi.fn(() => false) }));
vi.mock("../../lib/coingecko-onchain", () => ({
  onchainRateLimit: vi.fn(async () => {}),
  CG_CHAIN_MAP: {},
}));
vi.mock("../../lib/chain-registry", () => ({ GT_CHAIN_MAP: {} }));
vi.mock("../../lib/rate-limit", () => ({ RATE_LIMITS: {} }));
vi.mock("../../lib/dex-constants", () => ({ GT_API_BASE: "", normalizeDexSymbol: vi.fn((s: string) => s) }));
vi.mock("../../lib/abort", () => ({ sleepWithSignal: vi.fn() }));
vi.mock("../dex-liquidity/pool-helpers", () => ({
  normalizeProtocol: vi.fn((s: string) => s),
  getTrackedContracts: vi.fn(() => new Map()),
  classifyPoolType: vi.fn(() => "unknown"),
  isCryptoSwap: vi.fn(() => false),
}));
vi.mock("../dex-liquidity/price-sanity", () => ({ isPlausibleDexObservationPrice: vi.fn(() => true) }));
vi.mock("../../lib/price-validation", () => ({}));
vi.mock("../dex-liquidity/pool-identity", () => ({
  buildPoolIdentity: vi.fn(),
  createKnownPoolIdentityIndex: vi.fn(() => ({
    exactKeys: new Set(),
    derivedKeyCounts: new Map(),
    derivedToExactKeys: new Map(),
    wildcardKeyCounts: new Map(),
    wildcardToExactKeys: new Map(),
  })),
  registerKnownPoolIdentity: vi.fn(),
}));
vi.mock("../dex-liquidity/token-resolution", () => ({ resolveTrackedStablecoinId: vi.fn() }));
vi.mock("../dex-liquidity/subgraph-source-families", () => ({
  fetchAerodromeData: vi.fn(async () => ({ aerodromePriceObs: new Map(), aerodromeIsStable: new Map() })),
  fetchUniV3Data: vi.fn(async () => ({ uniV3PoolFees: new Map(), uniV3SymbolFees: new Map(), uniV3PriceObs: new Map() })),
}));


import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { setCache } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import { recordOutcome } from "../../lib/circuit-breaker";

// Must be imported AFTER vi.mock calls
const { fetchDataSources } = await import("../dex-liquidity/fetch-primary");

describe("fetchDataSources — malformed JSON resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Allow DL yields + protocols, block Curve circuit to isolate DL JSON handling
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });
  });

  it("degrades gracefully when DL yields returns invalid JSON", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce(null)   // yields
      .mockResolvedValueOnce(null);                              // protocols

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // Curve circuit is closed → curve payloads are all null → catastrophic check triggers → null
    // The key assertion: no unhandled SyntaxError thrown — function ran to completion.
    expect(result).toBeNull();
    // Circuit breaker should record DL yields failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-yields", false);
  });

  it("degrades gracefully when DL protocols returns invalid JSON", async () => {
    // Provide valid yields with 1000+ pools so dlYieldsAvailable = true
    const pools = Array.from({ length: 1001 }, (_, i) => ({
      pool: `pool-${i}`, chain: "Ethereum", project: `proj-${i}`, symbol: "USDC",
      tvlUsd: 1000, apy: 1, apyBase: 1, apyReward: 0, stablecoin: true, exposure: "single",
    }));
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      response: new Response("", { status: 200 }),
      body: { data: pools },
    })
      .mockResolvedValueOnce(null);

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // dlYieldsAvailable = true, so catastrophic check passes → returns DataSources
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1001);
    // Circuit breaker should record DL protocols failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-protocols", false);
  });

  it("caches compact DL protocol categories for yield source-management audits after a successful fetch", async () => {
    const pools = Array.from({ length: 1001 }, (_, i) => ({
      pool: `pool-${i}`, chain: "Ethereum", project: `proj-${i}`, symbol: "USDC",
      tvlUsd: 1000, apy: 1, apyBase: 1, apyReward: 0, stablecoin: true, exposure: "single",
    }));
    const protocols = [
      { slug: "aave-v3", category: "Lending", tvl: 1_000_000_000 },
      { slug: "curve-dex", category: "Dexs", tvl: 500_000_000 },
    ];
    vi.mocked(fetchJsonWithRetry).mockResolvedValueOnce({
      response: new Response("", { status: 200 }),
      body: { data: pools },
    })
      .mockResolvedValueOnce({
        response: new Response("", { status: 200 }),
        body: protocols,
      });

    const db = mockD1();
    const result = await fetchDataSources(null, db);

    expect(result).not.toBeNull();
    expect(setCache).toHaveBeenCalledWith(
      db,
      "defillama-protocols",
      JSON.stringify({
        protocols: [
          { slug: "aave-v3", category: "Lending" },
          { slug: "curve-dex", category: "Dexs" },
        ],
      }),
      undefined,
    );
  });
});
