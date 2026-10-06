import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTronHeadBlock,
  fetchTronBlockTransactionPositions,
  fetchTronDestroyWindowClear,
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

const DESTROY_EVENTS = [{ signature: "DestroyedBlackFunds(address,uint256)" }];

function destroyUrl(fingerprint: string): string {
  const url = new URL(`https://api.trongrid.io/v1/contracts/${CONTRACT}/events`);
  for (const [key, value] of Object.entries({
    event_name: "DestroyedBlackFunds", only_confirmed: "true",
    min_timestamp: String(WINDOW_START), max_timestamp: String(WINDOW_END),
    order_by: "block_timestamp,asc", limit: "200", fingerprint,
  })) url.searchParams.set(key, value);
  return url.toString();
}

function destroyEvent(victim: string, timestamp = WINDOW_START + 1) {
  return {
    block_number: 1, block_timestamp: timestamp, transaction_id: "a".repeat(64),
    event_index: 0, event_name: "DestroyedBlackFunds", result: { account: victim, _blackListedUser: victim },
  };
}

describe("fetchTronDestroyWindowClear", () => {
  it("follows complete multiple pages and retains the actual observation", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(transferPage([], destroyUrl("page2")))
      .mockResolvedValueOnce(transferPage([])));
    const ctx = providerContext();
    const result = await fetchTronDestroyWindowClear(ctx, CONTRACT, ACCOUNT, DESTROY_EVENTS, WINDOW_START, WINDOW_END);
    expect(result.outcome).toBe("clear");
    expect(result.observation).toMatchObject({ pagesFetched: 2, watermarkMs: WINDOW_END + 60_000, outcome: "clear" });
    expect(result.observation.urls[1]).toBe(destroyUrl("page2"));
    expect(ctx.pagesFetched.count).toBe(2);
  });

  it("rejects a window longer than its page cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(transferPage([], destroyUrl("page2"))));
    const ctx = providerContext();
    expect(await fetchTronDestroyWindowClear(ctx, CONTRACT, ACCOUNT, DESTROY_EVENTS, WINDOW_START, WINDOW_END, 1))
      .toMatchObject({ outcome: "evidence_mismatch", capExceeded: true });
    expect(ctx.pagesFetched.count).toBe(1);
  });

  it.each([ACCOUNT, USDT_CONTRACT_HEX, USDT_CONTRACT_HEX.slice(2), USDT_CONTRACT_HEX.slice(4)])("rejects a matching victim in base58 or hex form: %s", async (victim) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(transferPage([destroyEvent(victim)])));
    expect((await fetchTronDestroyWindowClear(providerContext(), CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).outcome).toBe("evidence_mismatch");
  });

  it("uses the configured victim key and admits an unrelated victim", async () => {
    const event = destroyEvent(ADDRESS_HEX);
    event.result._blackListedUser = ACCOUNT;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(transferPage([event])));
    expect((await fetchTronDestroyWindowClear(providerContext(), CONTRACT, ACCOUNT,
      [{ ...DESTROY_EVENTS[0]!, tronResultKey: "account" }], WINDOW_START, WINDOW_END)).outcome).toBe("clear");
  });

  it.each([WINDOW_START - 1, WINDOW_END + 1])("rejects out-of-window evidence at %s", async (timestamp) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(transferPage([destroyEvent(ADDRESS_HEX, timestamp)])));
    await expect(fetchTronDestroyWindowClear(providerContext(), CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).rejects.toMatchObject({ errorClass: "provider_null" });
  });

  it("classifies a malformed response as a metered provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [] })));
    const ctx = providerContext();
    await expect(fetchTronDestroyWindowClear(ctx, CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).rejects.toMatchObject({ errorClass: "provider_null" });
    expect(ctx.pagesFetched.count).toBe(1);
  });

  it("distinguishes a stale watermark from mismatching evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, data: [], meta: { at: WINDOW_END - 1 } })));
    expect((await fetchTronDestroyWindowClear(providerContext(), CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).outcome).toBe("state_raced");
  });

  it("stops before opening a request when runtime expires", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await fetchTronDestroyWindowClear(providerContext({ shouldStop: () => true }), CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).outcome).toBe("runtime_budget");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops between pages without treating the partial window as clear", async () => {
    const ctx = providerContext();
    ctx.shouldStop = () => ctx.pagesFetched.count >= 1;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(transferPage([], destroyUrl("page2"))));
    const result = await fetchTronDestroyWindowClear(ctx, CONTRACT, ACCOUNT, DESTROY_EVENTS, WINDOW_START, WINDOW_END);
    expect(result.outcome).toBe("runtime_budget");
    expect(result.observation.pagesFetched).toBe(1);
  });

  it.each([
    (url: URL) => { url.hostname = "evil.example"; },
    (url: URL) => { url.pathname = "/v1/contracts/other/events"; },
    (url: URL) => { url.searchParams.set("event_name", "OtherEvent"); },
    (url: URL) => { url.searchParams.set("only_confirmed", "false"); },
    (url: URL) => { url.searchParams.set("min_timestamp", "0"); },
    (url: URL) => { url.searchParams.set("max_timestamp", "0"); },
    (url: URL) => { url.searchParams.append("event_name", "OtherEvent"); },
  ])("rejects changed pagination bounds without fetching them", async (mutate) => {
    const next = new URL(destroyUrl("page2"));
    mutate(next);
    const fetch = vi.fn().mockResolvedValue(transferPage([], next.toString()));
    vi.stubGlobal("fetch", fetch);
    const ctx = providerContext();
    await expect(fetchTronDestroyWindowClear(ctx, CONTRACT, ACCOUNT,
      DESTROY_EVENTS, WINDOW_START, WINDOW_END)).rejects.toMatchObject({ errorClass: "provider_null" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.pagesFetched.count).toBe(2);
  });

  it("does not prove absence without any configured destroy family", async () => {
    await expect(fetchTronDestroyWindowClear(providerContext(), CONTRACT, ACCOUNT,
      [], WINDOW_START, WINDOW_END)).rejects.toMatchObject({ errorClass: "provider_null" });
  });
});

describe("fetchTronBlockTransactionPositions", () => {
  const block = {
    block_header: { raw_data: { number: 123, timestamp: WINDOW_START + 999 } },
    transactions: [{ txID: "A".repeat(64) }, { txID: "b".repeat(64) }],
  };

  it("returns canonical zero-based positions with lowercase ids and seconds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(block)));
    const result = await fetchTronBlockTransactionPositions(providerContext(), 123);
    expect(result.timestamp).toBe(Math.floor((WINDOW_START + 999) / 1000));
    expect([...result.positions]).toEqual([["a".repeat(64), 0], ["b".repeat(64), 1]]);
  });

  it.each([
    { ...block, block_header: { raw_data: { number: 124, timestamp: WINDOW_START } } },
    { ...block, transactions: {} },
    { ...block, transactions: [{ txID: "bad" }] },
    { ...block, transactions: [{ txID: "A".repeat(64) }, { txID: "a".repeat(64) }] },
  ])("rejects noncanonical block data", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    await expect(fetchTronBlockTransactionPositions(providerContext(), 123)).rejects.toMatchObject({ errorClass: "provider_null" });
  });
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
  it.each([
    [WINDOW_END - 1, WINDOW_END + 60_000],
    [WINDOW_END + 60_000, WINDOW_END - 1],
  ])("retains stale coverage across page watermarks %s and %s", async (first, second) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [], meta: { at: first, links: { next: windowUrl("page2") } } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [], meta: { at: second } })));
    const ctx = providerContext();
    const window = await fetchTronTransferWindow(ctx, ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10);
    expect(window).toMatchObject({ complete: true, stopped: false, watermarkMs: WINDOW_END - 1 });
    expect(ctx.pagesFetched.count).toBe(2);
  });

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
      { transactionId: "tx1", timestampMs: WINDOW_START + 1000, from: "TOther", to: ACCOUNT, value: BigInt(500) },
      { transactionId: "tx2", timestampMs: WINDOW_START + 2000, from: ACCOUNT, to: "TOther", value: BigInt(250) },
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
    expect(window.watermarkMs).toBe(0);
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

  it("classifies a retry-exhausted unparseable success body as a transport timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>nope</html>", { status: 200 })));
      const pending = expect(fetchTronHeadBlock(providerContext())).rejects.toMatchObject({
        errorClass: "provider_timeout",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled 200 response body inside the per-request deadline", async () => {
    vi.useFakeTimers();
    try {
      // Headers arrive immediately; the body never yields a byte, so only the
      // per-request timeout can end the read.
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* never enqueue, never close */
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )));
      const pending = expect(fetchTronHeadBlock(providerContext())).rejects.toMatchObject({
        errorClass: "provider_timeout",
      });
      await vi.advanceTimersByTimeAsync(50_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
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
