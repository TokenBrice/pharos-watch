import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type * as AbortModule from "../../lib/abort";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES } from "../../lib/fetch-retry";
import { DETAIL_UPSTREAM_TIMEOUT_MS, type DetailResponseHelpers } from "../stablecoin-detail/shared";
import {
  applyCuratedDetailAddress,
  DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES,
  handleDefiLlamaDetail,
  normalizeDefiLlamaDetailBody,
} from "../stablecoin-detail/defillama";

vi.mock("../../lib/abort", async (importOriginal) => ({
  ...(await importOriginal<typeof AbortModule>()),
  sleepWithSignal: vi.fn(async () => undefined),
}));

describe("applyCuratedDetailAddress", () => {
  it("returns already-normalized cached bodies unchanged without parsing", () => {
    const curatedAddress = "0x57ab1e0003f623289cd798b1824be09a793e4bec";
    const body = JSON.stringify({
      price: 0.99,
      address: curatedAddress,
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });
    const parseSpy = vi.spyOn(JSON, "parse");

    try {
      expect(
        applyCuratedDetailAddress(body, {
          contracts: [{ chain: "ethereum", address: curatedAddress, decimals: 18 }],
        }),
      ).toBe(body);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("adds the curated address to token-built cached bodies", () => {
    const body = JSON.stringify({
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });

    expect(
      JSON.parse(
        applyCuratedDetailAddress(body, {
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toEqual({
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
    });
  });

  it("overrides stale cached addresses when the curated address is absent", () => {
    const body = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });

    expect(
      JSON.parse(
        applyCuratedDetailAddress(body, {
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toEqual({
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
      tokens: [{ totalCirculatingUSD: { peggedUSD: 100 } }],
    });
  });

  it("overrides stale cached addresses when a nested address matches the curated address", () => {
    const curatedAddress = "0x57ab1e0003f623289cd798b1824be09a793e4bec";
    const body = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      tokens: [{ address: curatedAddress, totalCirculatingUSD: { peggedUSD: 100 } }],
    });

    expect(
      JSON.parse(
        applyCuratedDetailAddress(body, {
          contracts: [{ chain: "ethereum", address: curatedAddress, decimals: 18 }],
        }),
      ),
    ).toEqual({
      address: curatedAddress,
      tokens: [{ address: curatedAddress, totalCirculatingUSD: { peggedUSD: 100 } }],
    });
  });
});

describe("normalizeDefiLlamaDetailBody", () => {
  it("materializes native and USD supply fields for non-USD pegs without mutating raw circulating", () => {
    const body = JSON.stringify({
      price: 1.25,
      tokens: [
        {
          circulating: {
            peggedEUR: 80,
          },
        },
      ],
    });

    const normalized = normalizeDefiLlamaDetailBody(body, {
      flags: { pegCurrency: "EUR" },
    });

    expect(JSON.parse(normalized)).toEqual({
      price: 1.25,
      tokens: [
        {
          totalCirculating: {
            peggedEUR: 80,
          },
          totalCirculatingUSD: {
            peggedEUR: 100,
          },
          circulating: {
            peggedEUR: 80,
          },
        },
      ],
    });
  });

  it("materializes consistent fields for USD pegs", () => {
    const body = JSON.stringify({
      price: 0.99,
      tokens: [
        {
          circulating: { peggedUSD: 100 },
          totalCirculatingUSD: { peggedUSD: 100 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "USD" },
        }),
      ),
    ).toEqual({
      price: 0.99,
      tokens: [
        {
          totalCirculatingUSD: { peggedUSD: 100 },
          totalCirculating: { peggedUSD: 100 },
          circulating: { peggedUSD: 100 },
        },
      ],
    });
  });

  it.each(["circulating", "totalCirculating"])("fills missing USD totals from %s and the detail price", (field) => {
    const body = JSON.stringify({
      price: 0.99,
      tokens: [
        { date: 1_700_000_000, [field]: { peggedUSD: 100 } },
        { date: 1_700_086_400, [field]: { peggedUSD: 200 } },
        { date: 1_700_172_800, [field]: { peggedUSD: 0 } },
      ],
    });

    const normalized = JSON.parse(normalizeDefiLlamaDetailBody(body, { flags: { pegCurrency: "USD" } }));
    expect(normalized.tokens).toEqual([100, 200, 0].map((supply, index) => ({
      date: 1_700_000_000 + index * 86_400,
      [field]: { peggedUSD: supply },
      totalCirculating: { peggedUSD: supply },
      totalCirculatingUSD: { peggedUSD: supply * 0.99 },
    })));
  });

  it.each([undefined, null, 0, -1, "1"])("does not invent USD totals with invalid price %s", (price) => {
    const body = JSON.stringify({ price, tokens: [{ circulating: { peggedUSD: 100 } }] });
    const normalized = JSON.parse(normalizeDefiLlamaDetailBody(body, { flags: { pegCurrency: "USD" } }));
    expect(normalized.tokens[0].totalCirculatingUSD).toBeUndefined();
  });

  it("preserves explicit zero USD totals", () => {
    const body = JSON.stringify({
      price: 0.99,
      tokens: [{ circulating: { peggedUSD: 100 }, totalCirculatingUSD: { peggedUSD: 0 } }],
    });
    const normalized = JSON.parse(normalizeDefiLlamaDetailBody(body, { flags: { pegCurrency: "USD" } }));
    expect(normalized.tokens[0].totalCirculatingUSD).toEqual({ peggedUSD: 0 });
  });

  it("overrides stale DefiLlama top-level address with the curated registry contract", () => {
    const body = JSON.stringify({
      address: "0x4274cd7277c7bb0806bd5fe84b9adae466a8da0a",
      price: 0.99,
      tokens: [
        {
          circulating: { peggedUSD: 100 },
          totalCirculatingUSD: { peggedUSD: 100 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "USD" },
          contracts: [
            {
              chain: "ethereum",
              address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
              decimals: 18,
            },
          ],
        }),
      ),
    ).toMatchObject({
      address: "0x57ab1e0003f623289cd798b1824be09a793e4bec",
      tokens: [
        {
          totalCirculatingUSD: { peggedUSD: 100 },
          totalCirculating: { peggedUSD: 100 },
          circulating: { peggedUSD: 100 },
        },
      ],
    });
  });

  it("converts gold native history to USD using the detail price", () => {
    const body = JSON.stringify({
      price: 2_300,
      tokens: [
        {
          circulating: { peggedGOLD: 1_000 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "GOLD" },
        }),
      ),
    ).toEqual({
      price: 2_300,
      tokens: [
        {
          totalCirculating: { peggedGOLD: 1_000 },
          totalCirculatingUSD: { peggedGOLD: 2_300_000 },
          circulating: { peggedGOLD: 1_000 },
        },
      ],
    });
  });

  it("derives native units from USD totals when non-USD payload only exposes totalCirculatingUSD", () => {
    const body = JSON.stringify({
      price: 2,
      tokens: [
        {
          totalCirculatingUSD: { peggedEUR: 120 },
        },
      ],
    });

    expect(
      JSON.parse(
        normalizeDefiLlamaDetailBody(body, {
          flags: { pegCurrency: "EUR" },
        }),
      ),
    ).toEqual({
      price: 2,
      tokens: [
        {
          totalCirculatingUSD: { peggedEUR: 120 },
          totalCirculating: { peggedEUR: 60 },
        },
      ],
    });
  });

  it("throws for invalid upstream JSON", () => {
    expect(() => normalizeDefiLlamaDetailBody("{", { flags: { pegCurrency: "EUR" } })).toThrow();
  });

  it("strips the chainBalances blob while preserving other passthrough fields", () => {
    // chainBalances is ~98% of the upstream payload for large coins and once
    // pushed cached rows past D1's 2 MiB value cap (silently freezing them).
    const body = JSON.stringify({
      price: 1,
      pegMechanism: "fiat-backed",
      currentChainBalances: { Ethereum: { peggedUSD: 50 } },
      chainBalances: { Ethereum: { tokens: [{ date: 1, circulating: { peggedUSD: 100 } }] } },
      tokens: [{ totalCirculating: { peggedUSD: 100 } }],
    });

    const normalized = JSON.parse(
      normalizeDefiLlamaDetailBody(body, { flags: { pegCurrency: "USD" } }),
    ) as Record<string, unknown>;

    expect(normalized.chainBalances).toBeUndefined();
    expect(normalized.pegMechanism).toBe("fiat-backed");
    expect(normalized.currentChainBalances).toEqual({ Ethereum: { peggedUSD: 50 } });
  });

  it("strips chainBalances even when the payload has no tokens array", () => {
    const body = JSON.stringify({
      price: 1,
      chainBalances: { Ethereum: { tokens: [] } },
    });

    const normalized = JSON.parse(normalizeDefiLlamaDetailBody(body, undefined)) as Record<string, unknown>;

    expect(normalized.chainBalances).toBeUndefined();
    expect(normalized.price).toBe(1);
  });
});

function makeDetailHelpers(): DetailResponseHelpers {
  return {
    cached: null,
    createFreshResponseFromBody: vi.fn((body: string) => new Response(body)),
    createFreshResponseFromTokens: vi.fn((tokens) => new Response(JSON.stringify({ tokens }))),
    resolveTokensWithSupplyHistoryFallback: vi.fn(async (tokens) => tokens),
    staleCacheOrError: vi.fn((status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), { status })),
    trySupplyHistoryFallback: vi.fn(async () => null),
  };
}

function detailCircuitWrites(db: MockD1Database): Array<Record<string, unknown>> {
  return db.getHistory()
    .filter(({ sql, binds }) => sql.includes("INSERT") && binds[0] === `circuit:${CIRCUIT_SOURCE.DL_STABLECOIN_DETAIL}`)
    .map(({ binds }) => JSON.parse(String(binds[1])) as Record<string, unknown>);
}

describe("DefiLlama detail bounded materialization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("consumes a flagship-sized body above the shared default and closes a due half-open probe", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([{
      match: "cache",
      rows: [],
      first: {
        value: JSON.stringify({
          state: "open",
          consecutiveFailures: 5,
          lastFailureAt: now - 1801,
          lastSuccessAt: now - 3600,
          openedAt: now - 1801,
        }),
        updated_at: now - 1801,
      },
    }]);
    const body = JSON.stringify({
      id: "2",
      price: 1,
      tokens: [{ date: now, circulating: { peggedUSD: 100 } }],
      chainBalances: { unusedHistory: "x".repeat(23 * 1024 * 1024) },
    });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES);
    expect(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES).toBe(32 * 1024 * 1024);
    const fetch = mockFetch([{ match: "https://stablecoins.llama.fi/stablecoin/2", respond: () => new Response(body) }]);
    const detail = makeDetailHelpers();

    const response = await handleDefiLlamaDetail({
      db, stablecoinId: "usdc-circle", llamaId: "2", meta: { flags: { pegCurrency: "USD" } },
    }, detail);

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const normalized = await response.json() as Record<string, unknown>;
    expect(normalized.chainBalances).toBeUndefined();
    expect(normalized.tokens).toEqual([{
      date: now,
      circulating: { peggedUSD: 100 },
      totalCirculating: { peggedUSD: 100 },
      totalCirculatingUSD: { peggedUSD: 100 },
    }]);
    expect(detailCircuitWrites(db)).toEqual([
      expect.objectContaining({ state: "half-open" }),
      expect.objectContaining({ state: "closed", consecutiveFailures: 0, openedAt: null }),
    ]);
  });

  it.each(["declared", "streamed"])("fails closed and cancels %s bodies beyond the detail-specific cap", async (mode) => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    const cancellations = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const fetch = mockFetch([{
      match: "https://stablecoins.llama.fi/stablecoin/1",
      respond: () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunk); },
        cancel: cancellations,
      }, { highWaterMark: 0 }), mode === "declared" ? {
        headers: { "Content-Length": String(DEFILLAMA_DETAIL_MAX_RESPONSE_BYTES + 1) },
      } : undefined),
    }]);
    const detail = makeDetailHelpers();

    const response = await handleDefiLlamaDetail({
      db, stablecoinId: "usdt-tether", llamaId: "1", meta: undefined,
    }, detail);

    expect(response.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cancellations).toHaveBeenCalledTimes(3);
    expect(detail.createFreshResponseFromBody).not.toHaveBeenCalled();
    expect(detailCircuitWrites(db)).toEqual([expect.objectContaining({ consecutiveFailures: 1 })]);
  });

  it("isolates repeated missing-id 404s without hiding the unavailable asset or blocking another coin", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    const fetch = mockFetch([
      { match: "https://stablecoins.llama.fi/stablecoin/missing", status: 404, body: "Not Found" },
      { match: "https://stablecoins.llama.fi/stablecoin/118", body: { tokens: [], price: 1 } },
    ]);
    for (let index = 0; index < 4; index++) {
      const response = await handleDefiLlamaDetail({
        db, stablecoinId: "missing-asset", llamaId: "missing", meta: undefined,
      }, makeDetailHelpers());
      expect(response.status).toBe(502);
    }
    expect(detailCircuitWrites(db)).toEqual([]);
    const response = await handleDefiLlamaDetail({
      db, stablecoinId: "gho-aave", llamaId: "118", meta: undefined,
    }, makeDetailHelpers());
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(detailCircuitWrites(db)).toEqual([expect.objectContaining({ state: "closed", consecutiveFailures: 0 })]);
  });

  it("releases materialization after a parse failure and retains provider failure accounting", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    const fetch = mockFetch([
      { match: "https://stablecoins.llama.fi/stablecoin/1", respond: () => new Response("{") },
      { match: "https://stablecoins.llama.fi/stablecoin/118", body: { tokens: [], price: 1 } },
    ], { strictUrl: true });
    const invalid = await handleDefiLlamaDetail({
      db, stablecoinId: "usdt-tether", llamaId: "1", meta: undefined,
    }, makeDetailHelpers());
    expect(invalid.status).toBe(502);
    expect(detailCircuitWrites(db)).toEqual([expect.objectContaining({ consecutiveFailures: 1 })]);
    const recovered = await handleDefiLlamaDetail({
      db, stablecoinId: "gho-aave", llamaId: "118", meta: undefined,
    }, makeDetailHelpers());
    expect(recovered.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    const circuitWrites = detailCircuitWrites(db);
    expect(circuitWrites[circuitWrites.length - 1]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("serializes different ids until the first body has been consumed and normalized", async () => {
    const db = mockD1([{ match: "cache", rows: [] }]);
    let finishBody!: () => void;
    const firstBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode('{"tokens":[],"price":1}'));
          controller.close();
        };
      },
    });
    let firstFetched!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstFetched = resolve; });
    const fetch = mockFetch([
      {
        match: "https://stablecoins.llama.fi/stablecoin/1",
        respond: () => { firstFetched(); return new Response(firstBody); },
      },
      { match: "https://stablecoins.llama.fi/stablecoin/2", body: { tokens: [], price: 1 } },
    ]);
    const first = handleDefiLlamaDetail({
      db, stablecoinId: "usdt-tether", llamaId: "1", meta: undefined,
    }, makeDetailHelpers());
    await firstStarted;
    const second = handleDefiLlamaDetail({
      db, stablecoinId: "usdc-circle", llamaId: "2", meta: undefined,
    }, makeDetailHelpers());
    try {
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      finishBody();
      await Promise.all([first, second]);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("expires queued requests without fetching or recording a provider failure and removes the waiter", async () => {
    vi.useFakeTimers();
    const db = mockD1([
      { match: "SELECT", rows: [] },
      { match: "INSERT", rows: [], delayMs: 2 * DETAIL_UPSTREAM_TIMEOUT_MS },
    ]);
    const fetch = mockFetch([
      { match: "https://stablecoins.llama.fi/stablecoin/1", body: { tokens: [], price: 1 } },
      { match: "https://stablecoins.llama.fi/stablecoin/118", body: { tokens: [], price: 1 } },
    ]);
    const first = handleDefiLlamaDetail({
      db, stablecoinId: "usdt-tether", llamaId: "1", meta: undefined,
    }, makeDetailHelpers());
    // The provider body is complete, but the first operation still holds its
    // allocation while its circuit write awaits D1.
    await vi.advanceTimersByTimeAsync(0);
    const detail = makeDetailHelpers();
    const queued = handleDefiLlamaDetail({
      db, stablecoinId: "usdc-circle", llamaId: "2", meta: undefined,
    }, detail);
    try {
      await vi.advanceTimersByTimeAsync(DETAIL_UPSTREAM_TIMEOUT_MS);
      expect((await queued).status).toBe(503);
      expect(detail.trySupplyHistoryFallback).toHaveBeenCalledWith("defillama-detail-admission-timeout");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(detailCircuitWrites(db)).toEqual([expect.objectContaining({ state: "closed", consecutiveFailures: 0 })]);
    } finally {
      await vi.advanceTimersByTimeAsync(DETAIL_UPSTREAM_TIMEOUT_MS);
      await first;
    }
    const next = handleDefiLlamaDetail({
      db, stablecoinId: "gho-aave", llamaId: "118", meta: undefined,
    }, makeDetailHelpers());
    await vi.advanceTimersByTimeAsync(2 * DETAIL_UPSTREAM_TIMEOUT_MS);
    expect((await next).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
