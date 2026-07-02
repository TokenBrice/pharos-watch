import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWithRetryMock,
  shouldAttemptFetchMock,
  recordOutcomeMock,
} = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
  shouldAttemptFetchMock: vi.fn(),
  recordOutcomeMock: vi.fn(),
}));

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

vi.mock("../coingecko", () => ({
  cgHeaders: (extra?: Record<string, string>) => extra ?? {},
  cgUrl: (path: string, apiKey: string | null = null) =>
    `${apiKey ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3"}${path}`,
}));

vi.mock("../circuit-breaker", () => ({
  shouldAttemptFetch: shouldAttemptFetchMock,
  recordOutcome: recordOutcomeMock,
}));

vi.mock("../rate-limit", () => ({
  RATE_LIMITS: {
    GECKO_TERMINAL_MS: 0,
  },
}));

vi.mock("@shared/lib/chains", () => ({
  CG_CHAIN_MAP: {
    ethereum: "eth",
  },
  GT_CHAIN_MAP: {
    ethereum: "eth",
    monad: "monad",
    plasma: "plasma",
  },
}));

vi.mock("@shared/lib/stablecoins/registry", () => ({
  ACTIVE_STABLECOINS: [
    {
      id: "asset-404",
      contracts: [{ chain: "ethereum", address: "0xasset404" }],
    },
    {
      id: "asset-429",
      contracts: [{ chain: "ethereum", address: "0xasset429" }],
    },
    {
      id: "asset-cg",
      contracts: [{ chain: "ethereum", address: "0xassetcg" }],
    },
    {
      id: "asset-fallthrough",
      contracts: [
        { chain: "plasma", address: "0xplasma" },
        { chain: "monad", address: "0xmonad" },
      ],
    },
  ],
}));

import { CIRCUIT_SOURCE, GT_PROBE_RUN_BUDGET_MS } from "../constants";
import { extractPoolPrice, probeGeckoTerminalPrices } from "../geckoterminal-price-probe";
import type { GtPool } from "../../cron/dex-liquidity/types";

describe("extractPoolPrice", () => {
  const baseAddress = "0xabcdef1234567890abcdef1234567890abcdef12";

  it("returns price from highest-TVL pool where token is base", () => {
    const pools = [
      makePool({
        reserveUsd: "500000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(500000);
    expect(result!.side).toBe("base");
  });

  it("returns price from highest-TVL pool where token is quote", () => {
    const pools = [
      makePool({
        reserveUsd: "200000",
        basePriceUsd: "1.19",
        quotePriceUsd: "0.95",
        baseTokenId: "eth_0xother",
        quoteTokenId: `eth_${baseAddress}`,
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.95);
    expect(result!.side).toBe("quote");
  });

  it("returns null when token address matches neither base nor quote", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "1.00",
        quotePriceUsd: "1.00",
        baseTokenId: "eth_0xother1",
        quoteTokenId: "eth_0xother2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).toBeNull();
  });

  it("returns null when TVL is below threshold", () => {
    const pools = [
      makePool({
        reserveUsd: "5000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress, 10_000);
    expect(result).toBeNull();
  });

  it("picks highest-TVL pool among multiple", () => {
    const pools = [
      makePool({
        reserveUsd: "50000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
      makePool({
        reserveUsd: "800000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.19",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote2",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(850000);
  });

  it("collapses multiple pools from the same protocol via TVL-weighted median", () => {
    const pools = [
      makePool({
        reserveUsd: "300000",
        basePriceUsd: "0.98",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
        dexId: "curve",
      }),
      makePool({
        reserveUsd: "700000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote2",
        dexId: "curve",
      }),
    ];

    const result = extractPoolPrice(pools, baseAddress);

    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.80);
    expect(result!.tvlUsd).toBe(1_000_000);
    expect(result!.protocolCount).toBe(1);
  });

  it("aggregates across protocols via TVL-weighted median of protocol groups", () => {
    const pools = [
      makePool({
        reserveUsd: "600000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
        dexId: "curve",
      }),
      makePool({
        reserveUsd: "500000",
        basePriceUsd: "0.80",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote2",
        dexId: "uniswap",
      }),
    ];

    const result = extractPoolPrice(pools, baseAddress);

    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.99);
    expect(result!.tvlUsd).toBe(1_100_000);
    expect(result!.protocolCount).toBe(2);
  });

  it("returns null for empty pool list", () => {
    expect(extractPoolPrice([], baseAddress)).toBeNull();
  });

  it("returns null when price is zero or NaN", () => {
    const pools = [
      makePool({
        reserveUsd: "100000",
        basePriceUsd: "0",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    expect(extractPoolPrice(pools, baseAddress)).toBeNull();
  });

  it("handles case-insensitive address matching", () => {
    const pools = [
      makePool({
        reserveUsd: "200000",
        basePriceUsd: "0.99",
        quotePriceUsd: "1.00",
        baseTokenId: `eth_${baseAddress.toUpperCase()}`,
        quoteTokenId: "eth_0xquote",
      }),
    ];
    const result = extractPoolPrice(pools, baseAddress);
    expect(result).not.toBeNull();
    expect(result!.price).toBe(0.99);
  });
});

describe("probeGeckoTerminalPrices", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
    shouldAttemptFetchMock.mockReset();
    recordOutcomeMock.mockReset();

    shouldAttemptFetchMock.mockResolvedValue(true);
    recordOutcomeMock.mockResolvedValue(undefined);
  });

  it("treats lookup misses as source-healthy for breaker accounting", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), { status: 404 }),
    );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-404", price: 1 }],
      {} as D1Database,
    );

    expect(result.prices.size).toBe(0);
    expect(result.stats.probed).toBe(1);
    expect(result.stats.lookupMisses).toBe(1);
    expect(result.stats.upstreamErrors).toBe(0);
    expect(result.stats.publicFallbacks).toBe(0);
    expect(result.stats.transports.geckoTerminalPublic.attempted).toBe(1);
    expect(result.stats.transports.geckoTerminalPublic.lookupMisses).toBe(1);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
  });

  it("records breaker failure when every probe is a hard upstream error", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-429", price: 1 }],
      {} as D1Database,
    );

    expect(result.stats.lookupMisses).toBe(0);
    expect(result.stats.upstreamErrors).toBe(1);
    expect(result.stats.transports.geckoTerminalPublic.upstreamErrors).toBe(1);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      false,
    );
  });

  it("keeps the breaker closed when at least one probe reaches the source", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
      );

    const result = await probeGeckoTerminalPrices(
      [
        { id: "asset-404", price: 1 },
        { id: "asset-429", price: 1 },
      ],
      {} as D1Database,
    );

    expect(result.stats.lookupMisses).toBe(1);
    expect(result.stats.upstreamErrors).toBe(1);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
  });

  it("prefers authenticated CoinGecko onchain pools when available", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          makePool({
            reserveUsd: "250000",
            basePriceUsd: "0.998",
            quotePriceUsd: "1.002",
            baseTokenId: "eth_0xassetcg",
            quoteTokenId: "eth_0xquote",
            dexId: "curve",
          }),
        ],
      }), { status: 200 }),
    );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-cg", price: 1 }],
      {} as D1Database,
      undefined,
      "cg-key",
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("/onchain/networks/eth/tokens/0xassetcg/pools");
    expect(result.prices.get("asset-cg")?.metadata).toMatchObject({
      transport: "coingecko-onchain",
      poolAddress: "0xpool",
      protocolCount: 1,
    });
    expect(result.stats.publicFallbacks).toBe(0);
    expect(result.stats.transports.coingeckoOnchain.attempted).toBe(1);
    expect(result.stats.transports.coingeckoOnchain.priced).toBe(1);
    expect(result.stats.transports.geckoTerminalPublic.attempted).toBe(0);
  });

  it("falls back to public GeckoTerminal when onchain does not yield a usable pool", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            makePool({
              reserveUsd: "300000",
              basePriceUsd: "0.999",
              quotePriceUsd: "1.001",
              baseTokenId: "eth_0xassetcg",
              quoteTokenId: "eth_0xquote",
              dexId: "curve",
            }),
          ],
        }), { status: 200 }),
      );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-cg", price: 1 }],
      {} as D1Database,
      undefined,
      "cg-key",
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("/onchain/networks/eth/tokens/0xassetcg/pools");
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("/networks/eth/tokens/0xassetcg/pools");
    expect(result.prices.get("asset-cg")?.metadata).toMatchObject({
      transport: "geckoterminal-public",
      poolAddress: "0xpool",
      protocolCount: 1,
    });
    expect(result.stats.lookupMisses).toBe(0);
    expect(result.stats.publicFallbacks).toBe(1);
    expect(result.stats.transports.coingeckoOnchain.attempted).toBe(1);
    expect(result.stats.transports.coingeckoOnchain.lookupMisses).toBe(1);
    expect(result.stats.transports.geckoTerminalPublic.attempted).toBe(1);
    expect(result.stats.transports.geckoTerminalPublic.priced).toBe(1);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
  });

  it("counts rounded midpoint divergences for priced probes", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          makePool({
            reserveUsd: "250000",
            basePriceUsd: "0.90",
            quotePriceUsd: "1.00",
            baseTokenId: "eth_0xassetcg",
            quoteTokenId: "eth_0xquote",
            dexId: "curve",
          }),
        ],
      }), { status: 200 }),
    );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-cg", price: 1 }],
      {} as D1Database,
      undefined,
      "cg-key",
    );

    expect(result.stats.divergences500bps).toBe(1);
  });

  it("does not count non-finite midpoint divergence outputs", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({
        data: [
          makePool({
            reserveUsd: "250000",
            basePriceUsd: String(Number.MAX_VALUE),
            quotePriceUsd: "1.00",
            baseTokenId: "eth_0xassetcg",
            quoteTokenId: "eth_0xquote",
            dexId: "curve",
          }),
        ],
      }), { status: 200 }),
    );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-cg", price: Number.MAX_VALUE }],
      {} as D1Database,
      undefined,
      "cg-key",
    );

    expect(result.prices.size).toBe(1);
    expect(result.stats.divergences500bps).toBe(0);
  });

  it("falls through supported contracts until a usable pool is found", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            makePool({
              reserveUsd: "705000",
              basePriceUsd: "1.0004",
              quotePriceUsd: "1.0000",
              baseTokenId: "monad_0xmonad",
              quoteTokenId: "monad_0xquote",
              dexId: "uniswap",
            }),
          ],
        }), { status: 200 }),
      );

    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-fallthrough", price: 1 }],
      {} as D1Database,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[0]).toContain("/networks/plasma/tokens/0xplasma/pools");
    expect(fetchWithRetryMock.mock.calls[1]?.[0]).toContain("/networks/monad/tokens/0xmonad/pools");
    expect(result.stats.probed).toBe(1);
    expect(result.stats.lookupMisses).toBe(0);
    expect(result.stats.transports.geckoTerminalPublic.lookupMisses).toBe(1);
    expect(result.prices.get("asset-fallthrough")?.metadata).toMatchObject({
      chain: "monad",
      transport: "geckoterminal-public",
      poolAddress: "0xpool",
    });
  });

  it("does not mark the source unhealthy when nothing was probeable", async () => {
    const result = await probeGeckoTerminalPrices(
      [{ id: "unknown-asset", price: 1 }],
      {} as D1Database,
    );

    expect(result.stats.probed).toBe(0);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(result.stats.transports.coingeckoOnchain.attempted).toBe(0);
    expect(result.stats.transports.geckoTerminalPublic.attempted).toBe(0);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
  });

  it("skips probeable candidates without opening fetches when caller budget is exhausted", async () => {
    const result = await probeGeckoTerminalPrices(
      [{ id: "asset-404", price: 1 }],
      {} as D1Database,
      undefined,
      null,
      { budgetMs: 0 },
    );

    expect(result.prices.size).toBe(0);
    expect(result.stats.probed).toBe(0);
    expect(result.stats.budgetExhausted).toBe(true);
    expect(result.stats.budgetSkipped).toBe(1);
    expect(fetchWithRetryMock).not.toHaveBeenCalled();
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
  });

  it("stops probing when the run budget is exhausted and reports skipped candidates", async () => {
    vi.useFakeTimers();
    fetchWithRetryMock.mockImplementation((_url: string, opts?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      })
    );

    const resultPromise = probeGeckoTerminalPrices(
      [
        { id: "asset-404", price: 1 },
        { id: "asset-429", price: 1 },
      ],
      {} as D1Database,
    );

    await vi.advanceTimersByTimeAsync(GT_PROBE_RUN_BUDGET_MS + 1);
    const result = await resultPromise;

    expect(result.stats.probed).toBe(1);
    expect(result.stats.budgetExhausted).toBe(true);
    expect(result.stats.budgetSkipped).toBe(1);
    expect(result.stats.upstreamErrors).toBe(0);
    expect(recordOutcomeMock).toHaveBeenCalledWith(
      expect.anything(),
      CIRCUIT_SOURCE.GECKO_TERMINAL_PROBE,
      true,
    );
    vi.useRealTimers();
  });
});

function makePool(opts: {
  reserveUsd: string;
  basePriceUsd: string;
  quotePriceUsd: string;
  baseTokenId: string;
  quoteTokenId: string;
  dexId?: string;
}): GtPool {
  return {
    id: "pool_1",
    type: "pool",
    attributes: {
      address: "0xpool",
      name: "TEST/USDC",
      pool_created_at: null,
      base_token_price_usd: opts.basePriceUsd,
      quote_token_price_usd: opts.quotePriceUsd,
      reserve_in_usd: opts.reserveUsd,
      volume_usd: { h24: "0" },
    },
    relationships: {
      base_token: { data: { id: opts.baseTokenId, type: "token" } },
      quote_token: { data: { id: opts.quoteTokenId, type: "token" } },
      dex: { data: { id: opts.dexId ?? "curve", type: "dex" } },
    },
  };
}
