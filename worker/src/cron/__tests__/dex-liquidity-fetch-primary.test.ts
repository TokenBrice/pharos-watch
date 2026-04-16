import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Isolate the module under test from its heavy dependency tree
vi.mock("../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));
vi.mock("../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(),
  recordOutcome: vi.fn(async () => {}),
}));
vi.mock("../../lib/db-cache", () => ({ setCache: vi.fn(async () => {}) }));
vi.mock("../yield-sync/cache", () => ({ buildDlStablecoinPoolsCache: vi.fn(() => "{}") }));
vi.mock("../yield-sync/pool-filter", () => ({ isYieldRelevantDlPool: vi.fn(() => false) }));
vi.mock("../../lib/coingecko-onchain", () => ({
  fetchCgTokensBatch: vi.fn(),
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


import { fetchWithRetry } from "../../lib/fetch-retry";
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
    const badResponse = {
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(badResponse)   // yields
      .mockResolvedValueOnce(null);                                 // protocols

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // Curve circuit is closed → curveResponses are all null → catastrophic check triggers → null
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
    const goodYieldsResponse = {
      ok: true,
      json: async () => ({ data: pools }),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;
    const badProtocolsResponse = {
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      body: { cancel: async () => {} },
      bodyUsed: false,
    } as unknown as Response;

    vi.mocked(fetchWithRetry).mockResolvedValueOnce(goodYieldsResponse)
      .mockResolvedValueOnce(badProtocolsResponse);

    const db = mockD1();
    const result = await fetchDataSources(null, db);
    // dlYieldsAvailable = true, so catastrophic check passes → returns DataSources
    expect(result).not.toBeNull();
    expect(result!.pools).toHaveLength(1001);
    // Circuit breaker should record DL protocols failure
    expect(recordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-protocols", false);
  });
});
