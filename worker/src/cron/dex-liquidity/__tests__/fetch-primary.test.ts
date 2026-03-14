import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock circuit breaker module
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Mock fetch-retry
vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async () => new Response("{}", { status: 200 })),
}));

// Mock db-cache
vi.mock("../../../lib/db-cache", () => ({
  setCache: vi.fn(async () => {}),
  getCache: vi.fn(async () => null),
}));

// Mock yield cache builder
vi.mock("../../yield-sync/cache", () => ({
  buildDlStablecoinPoolsCache: vi.fn(() => ({})),
}));

import { shouldAttemptFetch, recordOutcome } from "../../../lib/circuit-breaker";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchDataSources } from "../fetch-primary";

function createMockDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

// Generate 1000+ minimal pool entries to pass the DL threshold
const FAKE_DL_POOLS = Array.from({ length: 1001 }, (_, i) => ({
  pool: `pool-${i}`,
  chain: "ethereum",
  project: "aave-v3",
  symbol: `USDC-${i}`,
  tvlUsd: 100000,
  apy: 5,
  apyBase: 5,
  apyReward: 0,
  stablecoin: true,
  exposure: "single",
  underlyingTokens: null,
}));

function mockDlYieldsSuccess() {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("yields.llama.fi")) {
      return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
    }
    if (urlStr.includes("api.llama.fi/protocols")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (urlStr.includes("api.curve.finance")) {
      return new Response(JSON.stringify({ data: { poolData: [] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("fetchDataSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    mockDlYieldsSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips Curve when circuit breaker is open", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    // Curve calls should not have been made
    const curveCalls = vi.mocked(fetchWithRetry).mock.calls.filter(
      (call) => String(call[0]).includes("api.curve.finance"),
    );
    expect(curveCalls).toHaveLength(0);
  });

  it("records success when at least 1 Curve chain succeeds", async () => {
    mockDlYieldsSuccess();
    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      true,
    );
  });

  it("records failure when all Curve chains fail", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull(); // DL is still up
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      false,
    );
  });

  it("returns DL-only data when Curve fails", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: FAKE_DL_POOLS }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("returns null when both DL and Curve fail (catastrophic)", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      return new Response("error", { status: 500 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).toBeNull();
  });

  it("returns DL-only data when circuit breaker is open and DL succeeds", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });
});
