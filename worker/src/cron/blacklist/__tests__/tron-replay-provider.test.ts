import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTronHeadBlock,
  fetchTronRawTokenBalance,
  fetchTronTransactionInfo,
  fetchTronTransferWindow,
  validateTronTransferPaginationUrl,
  type TronReplayProviderContext,
} from "../../../lib/blacklist/tron-replay-provider";
import { createBudget } from "../../../lib/evm-logs";

const ACCOUNT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ADDRESS_HEX = "0x6f566c6d608550fb50c9365bdb6665e1c8e53caa";
const USDT_CONTRACT_HEX = "0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const WINDOW_START = 1_790_000_000_000;
const WINDOW_END = 1_790_100_000_000;

function windowUrl(fingerprint?: string): string {
  const url = new URL(`https://api.trongrid.io/v1/accounts/${ACCOUNT}/transactions/trc20`);
  url.searchParams.set("only_confirmed", "true");
  url.searchParams.set("contract_address", CONTRACT);
  url.searchParams.set("min_timestamp", String(WINDOW_START));
  url.searchParams.set("max_timestamp", String(WINDOW_END));
  url.searchParams.set("order_by", "block_timestamp,asc");
  url.searchParams.set("limit", "200");
  if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
  return url.toString();
}

function providerContext(overrides: Partial<TronReplayProviderContext> = {}): TronReplayProviderContext {
  return {
    apiKey: "tron-key",
    limiter: <T,>(fn: () => Promise<T>) => fn(),
    budget: createBudget(100),
    pagesFetched: { count: 0 },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function transferPage(data: Array<Record<string, unknown>>, next?: string): Response {
  return jsonResponse({
    success: true,
    data,
    meta: { at: WINDOW_END + 60_000, ...(next ? { links: { next } } : {}) },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateTronTransferPaginationUrl", () => {
  it("accepts the canonical window URL and a fingerprint hop", () => {
    expect(validateTronTransferPaginationUrl(windowUrl(), CONTRACT, WINDOW_START, WINDOW_END)).toBe(windowUrl());
    expect(validateTronTransferPaginationUrl(windowUrl("abc"), CONTRACT, WINDOW_START, WINDOW_END)).toBe(windowUrl("abc"));
  });

  it("rejects changed bounds, foreign hosts, and extra filters", () => {
    const changedBounds = new URL(windowUrl());
    changedBounds.searchParams.set("max_timestamp", String(WINDOW_END + 1));
    expect(validateTronTransferPaginationUrl(changedBounds.toString(), CONTRACT, WINDOW_START, WINDOW_END)).toBeNull();

    const otherContract = new URL(windowUrl());
    otherContract.searchParams.set("contract_address", "TElsewhere");
    expect(validateTronTransferPaginationUrl(otherContract.toString(), CONTRACT, WINDOW_START, WINDOW_END)).toBeNull();

    expect(
      validateTronTransferPaginationUrl(
        windowUrl().replace("api.trongrid.io", "evil.example.com"),
        CONTRACT,
        WINDOW_START,
        WINDOW_END,
      ),
    ).toBeNull();

    const extraFilter = new URL(windowUrl());
    extraFilter.searchParams.set("min_block_timestamp", "0");
    expect(validateTronTransferPaginationUrl(extraFilter.toString(), CONTRACT, WINDOW_START, WINDOW_END)).toBeNull();
  });
});

describe("fetchTronTransferWindow", () => {
  it("follows fingerprints, counts pages on the shared meter, and drops non-transfer records", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      return new URL(url).searchParams.has("fingerprint")
        ? transferPage([
          { transaction_id: "tx2", block_timestamp: WINDOW_START + 2000, from: ACCOUNT, to: "TOther", type: "Transfer", value: "250" },
          { transaction_id: "tx3", block_timestamp: WINDOW_START + 3000, from: ACCOUNT, to: "TOther", type: "Approval", value: "0" },
        ])
        : transferPage([
          { transaction_id: "tx1", block_timestamp: WINDOW_START + 1000, from: "TOther", to: ACCOUNT, type: "Transfer", value: "500" },
        ], windowUrl("abc"));
    }));

    const ctx = providerContext();
    const window = await fetchTronTransferWindow(ctx, ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10);
    expect(window.complete).toBe(true);
    expect(window.stopped).toBe(false);
    expect(ctx.pagesFetched.count).toBe(2);
    expect(window.transfers).toEqual([
      { timestampMs: WINDOW_START + 1000, from: "TOther", to: ACCOUNT, value: BigInt(500) },
      { timestampMs: WINDOW_START + 2000, from: ACCOUNT, to: "TOther", value: BigInt(250) },
    ]);
  });

  it("counts pages that fail so the run page budget covers unproductive requests", async () => {
    const ctx = providerContext();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      // A non-retryable status keeps the assertion about metering, not backoff.
      return calls === 1 ? transferPage([], windowUrl("fp1")) : jsonResponse({ error: "boom" }, 400);
    }));

    await expect(
      fetchTronTransferWindow(ctx, ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10),
    ).rejects.toThrow(/HTTP 400/);
    expect(ctx.pagesFetched.count).toBe(2);
  });

  it("reports a run-window stop separately from a truncated ledger", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => transferPage([], windowUrl("fp1"))));

    const ctx = providerContext({ shouldStop: () => true });
    const window = await fetchTronTransferWindow(ctx, ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10);
    expect(window.complete).toBe(false);
    expect(window.stopped).toBe(true);
    expect(ctx.pagesFetched.count).toBe(0);
  });

  it("refuses pagination that leaves the canonical window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => transferPage([], windowUrl("abc").replace("api.trongrid.io", "evil.example.com"))));
    await expect(
      fetchTronTransferWindow(providerContext(), ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10),
    ).rejects.toThrow(/pagination URL rejected/);
  });
});

describe("readTronJson status classification", () => {
  it("classifies a retry-exhausted 429 as an HTTP error rather than a timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ Error: "rate limited" }, 429)));
      const pending = expect(fetchTronTransactionInfo(providerContext(), "a".repeat(64))).rejects.toMatchObject({
        errorClass: "provider_http_error",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a retry-exhausted 5xx as an HTTP error", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ Error: "bad gateway" }, 502)));
      const pending = expect(fetchTronHeadBlock(providerContext())).rejects.toMatchObject({
        errorClass: "provider_http_error",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an unparseable success body as a null provider payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>nope</html>", { status: 200 })));
    await expect(fetchTronHeadBlock(providerContext())).rejects.toMatchObject({ errorClass: "provider_null" });
  });

  it("classifies a transport failure as a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));
    await expect(fetchTronHeadBlock(providerContext())).rejects.toMatchObject({ errorClass: "provider_timeout" });
  });
});

describe("solidified TronGrid reads", () => {
  it("reads a header-only solidified block instead of the full head block", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return jsonResponse({
        blockID: "A".repeat(64),
        block_header: { raw_data: { number: 86_476_871, timestamp: WINDOW_END } },
      });
    }));

    const head = await fetchTronHeadBlock(providerContext());
    expect(head).toEqual({ blockId: "a".repeat(64), blockNumber: 86_476_871, timestampMs: WINDOW_END });
    expect(calls[0]?.url).toBe("https://api.trongrid.io/walletsolidity/getblock");
    expect(calls[0]?.body).toEqual({ detail: false });
  });

  it("reads the raw balance from a solidified constant call", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return jsonResponse({
        result: { result: true },
        constant_result: ["00000000000000000000000000000000000000000000000000000000c2559eb1"],
      });
    }));

    const balance = await fetchTronRawTokenBalance(providerContext(), USDT_CONTRACT_HEX, ADDRESS_HEX);
    expect(balance).toBe(BigInt("0xc2559eb1"));
    expect(calls[0]?.url).toBe("https://api.trongrid.io/walletsolidity/triggerconstantcontract");
    expect(calls[0]?.body).toEqual({
      owner_address: `41${ADDRESS_HEX.slice(2)}`,
      contract_address: `41${USDT_CONTRACT_HEX.replace(/^0x/, "")}`,
      function_selector: "balanceOf(address)",
      parameter: ADDRESS_HEX.slice(2).padStart(64, "0"),
      visible: false,
    });
  });
});
