import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../../../lib/abort", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/abort")>();
  return {
    ...actual,
    sleepWithSignal: vi.fn(async (_ms: number, signal?: AbortSignal) => {
      actual.throwIfAborted(signal);
    }),
  };
});

import { fetchTronEventsIncremental, parseTronEvent, validateTronPaginationUrl } from "../tron-source";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { createBudget, type RateLimitedFetch } from "../../../lib/evm-logs";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import type { BlacklistRunBudget } from "../run-budget";

function findConfig(stablecoinId: string) {
  const config = CONTRACT_CONFIGS.find((c) => c.stablecoinId === stablecoinId && c.chain.chainId === "tron");
  if (!config) throw new Error(`No Tron config for ${stablecoinId}`);
  return config;
}

const noopLimiter: RateLimitedFetch = (fn) => fn();

function makeRunBudget(subrequestLimit = 100): BlacklistRunBudget {
  return {
    subrequestBudget: createBudget(subrequestLimit),
    deadlineMs: Date.now() + 60_000,
    minimumConfigWindowMs: 0,
  };
}

describe("parseTronEvent", () => {
  it("parses legacy USDT AddedBlackList via _blackListedUser key", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 100,
      block_timestamp: 1_700_000_000_000,
      transaction_id: "tx_abc",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { _blackListedUser: "0xaa".padEnd(42, "a") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0xaa".padEnd(42, "a"));
    expect(row!.amount_status).toBe("recoverable_pending");
  });

  it("parses legacy USDT DestroyedBlackFunds with amount from _balance", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 200,
      block_timestamp: 1_700_000_100_000,
      transaction_id: "tx_destroy",
      event_index: 1,
      event_name: "DestroyedBlackFunds",
      result: { _blackListedUser: "0xbb".padEnd(42, "b"), _balance: "12345000000" },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("destroy");
    expect(row!.amount_native).toBe(12345);
    expect(row!.amount_status).toBe("resolved");
  });

  it("parses USD1 Freeze via tronResultKey=account", () => {
    const config = findConfig("usd1-world-liberty-financial");
    const row = parseTronEvent(config, {
      block_number: 300,
      block_timestamp: 1_700_000_200_000,
      transaction_id: "tx_freeze",
      event_index: 0,
      event_name: "Freeze",
      result: { caller: "0x11".padEnd(42, "1"), account: "0x22".padEnd(42, "2") },
    });
    expect(row).not.toBeNull();
    expect(row!.event_type).toBe("blacklist");
    expect(row!.address).toBe("0x22".padEnd(42, "2"));
  });

  it("returns null on unknown event name", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 400,
      block_timestamp: 1_700_000_300_000,
      transaction_id: "tx_noop",
      event_index: 0,
      event_name: "Transfer",
      result: {},
    });
    expect(row).toBeNull();
  });

  it("falls back to positional slot 0 when no named key matches", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 500,
      block_timestamp: 1_700_000_400_000,
      transaction_id: "tx_positional",
      event_index: 0,
      event_name: "AddedBlackList",
      result: { "0": "0x33".padEnd(42, "3") },
    });
    expect(row).not.toBeNull();
    expect(row!.address).toBe("0x33".padEnd(42, "3"));
  });
});

describe("TronGrid pagination validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts only the same HTTPS endpoint, contract, and event", () => {
    const config = findConfig("usdt-tether");
    const eventName = "AddedBlackList";
    const valid = `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&fingerprint=abc`;

    expect(validateTronPaginationUrl(valid, config.contractAddress, eventName)).toBe(valid);
    expect(
      validateTronPaginationUrl(
        `https://example.com/v1/contracts/${config.contractAddress}/events?event_name=${eventName}`,
        config.contractAddress,
        eventName,
      ),
    ).toBeNull();
    expect(
      validateTronPaginationUrl(
        `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=RemovedBlackList`,
        config.contractAddress,
        eventName,
      ),
    ).toBeNull();
  });

  it("rejects a cyclic next link without issuing another request", async () => {
    const baseConfig = findConfig("usdt-tether");
    const firstEvent = baseConfig.events[0]!;
    const config: ContractEventConfig = { ...baseConfig, events: [firstEvent] };
    const eventName = firstEvent.signature.split("(")[0];
    const next = `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${eventName}&fingerprint=repeat`;
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [],
            meta: { links: { next } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [],
            meta: { links: { next } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await fetchTronEventsIncremental(config, "secret", 0, makeRunBudget(), noopLimiter);

    expect(result).toMatchObject({ apiError: true, incomplete: true, providerCalls: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchTronEventsIncremental cursor safety", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses confirmed, safe-head-bounded timestamp filters", async () => {
    const baseConfig = findConfig("usdt-tether");
    const config: ContractEventConfig = { ...baseConfig, events: [baseConfig.events[0]!] };
    const lastTimestampMs = Date.now() - 86_400_000;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: [], meta: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await fetchTronEventsIncremental(config, null, lastTimestampMs, makeRunBudget(), noopLimiter);

    const requested = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(requested.searchParams.get("min_timestamp")).toBe(String(lastTimestampMs));
    expect(Number(requested.searchParams.get("max_timestamp"))).toBeLessThanOrEqual(Date.now() - 15 * 60_000);
    expect(requested.searchParams.get("only_confirmed")).toBe("true");
  });

  it("marks the scan incomplete when a later event family fails", async () => {
    const config = findConfig("usdt-tether");
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                block_number: 100,
                block_timestamp: 1_700_000_000_000,
                transaction_id: "tx_tron_partial",
                event_index: 0,
                event_name: "AddedBlackList",
                result: { _blackListedUser: "0xaa".padEnd(42, "a") },
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    const result = await fetchTronEventsIncremental(config, null, 0, makeRunBudget(), noopLimiter);

    expect(result.rows).toHaveLength(1);
    expect(result.maxBlock).toBe(1_700_000_000_000);
    expect(result.apiError).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it("marks the scan incomplete when pagination is truncated by the subrequest budget", async () => {
    const baseConfig = findConfig("usdt-tether");
    const firstEvent = baseConfig.events[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) return;
    const config: ContractEventConfig = {
      ...baseConfig,
      events: [firstEvent],
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: [],
          meta: {
            links: {
              next: `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${firstEvent.signature.split("(")[0]}&fingerprint=page-2`,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchTronEventsIncremental(config, null, 0, makeRunBudget(1), noopLimiter);

    expect(result.rows).toHaveLength(0);
    expect(result.apiError).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
