import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTronTransferWindow,
  validateTronTransferPaginationUrl,
} from "../../../lib/blacklist/tron-replay-provider";
import { createBudget } from "../../../lib/evm-logs";

const ACCOUNT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
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

function providerContext(shouldStop?: () => boolean) {
  return {
    apiKey: "tron-key",
    limiter: <T>(fn: () => Promise<T>) => fn(),
    budget: createBudget(100),
    ...(shouldStop ? { shouldStop } : {}),
  };
}

function transferPage(data: Array<Record<string, unknown>>, next?: string): Response {
  return new Response(JSON.stringify({
    success: true,
    data,
    meta: { at: WINDOW_END + 60_000, ...(next ? { links: { next } } : {}) },
  }), { status: 200, headers: { "content-type": "application/json" } });
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
  it("follows fingerprints, counts pages, and drops non-transfer records", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const page = new URL(url).searchParams.has("fingerprint")
        ? transferPage([
          { transaction_id: "tx2", block_timestamp: WINDOW_START + 2000, from: ACCOUNT, to: "TOther", type: "Transfer", value: "250" },
          { transaction_id: "tx3", block_timestamp: WINDOW_START + 3000, from: ACCOUNT, to: "TOther", type: "Approval", value: "0" },
        ])
        : transferPage([
          { transaction_id: "tx1", block_timestamp: WINDOW_START + 1000, from: "TOther", to: ACCOUNT, type: "Transfer", value: "500" },
        ], windowUrl("abc"));
      return page;
    });
    vi.stubGlobal("fetch", fetchMock);

    const window = await fetchTronTransferWindow(providerContext(), ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10);
    expect(window.complete).toBe(true);
    expect(window.pages).toBe(2);
    expect(window.transfers).toEqual([
      { timestampMs: WINDOW_START + 1000, from: "TOther", to: ACCOUNT, value: BigInt(500) },
      { timestampMs: WINDOW_START + 2000, from: ACCOUNT, to: "TOther", value: BigInt(250) },
    ]);
  });

  it("reports an incomplete window when the run window closes mid-pagination", async () => {
    let pages = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      pages++;
      return transferPage([], windowUrl(`fp${pages}`));
    }));

    const window = await fetchTronTransferWindow(
      providerContext(() => pages >= 1),
      ACCOUNT,
      CONTRACT,
      WINDOW_START,
      WINDOW_END,
      10,
    );
    expect(window.complete).toBe(false);
    expect(window.pages).toBe(1);
  });

  it("refuses pagination that leaves the canonical window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => transferPage([], windowUrl("abc").replace("api.trongrid.io", "evil.example.com"))));
    await expect(
      fetchTronTransferWindow(providerContext(), ACCOUNT, CONTRACT, WINDOW_START, WINDOW_END, 10),
    ).rejects.toThrow(/pagination URL rejected/);
  });
});
