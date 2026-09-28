import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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
import type { BlacklistRunBudget } from "../../../lib/blacklist/run-budget";

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
      transaction_id: "ab".repeat(32),
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
      transaction_id: "cd".repeat(32),
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
      transaction_id: "ef".repeat(32),
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

  it("rejects a recognized event without required address evidence", () => {
    const config = findConfig("usdt-tether");
    expect(() => parseTronEvent(config, {
      block_number: 401,
      block_timestamp: 1_700_000_300_000,
      transaction_id: "ab".repeat(32),
      event_index: 1,
      event_name: "AddedBlackList",
      result: {},
    })).toThrow("invalid-address");
  });

  it("falls back to positional slot 0 when no named key matches", () => {
    const config = findConfig("usdt-tether");
    const row = parseTronEvent(config, {
      block_number: 500,
      block_timestamp: 1_700_000_400_000,
      transaction_id: "12".repeat(32),
      event_index: 0,
      event_name: "AddedBlackList",
      result: { "0": "0x33".padEnd(42, "3") },
    });
    expect(row).not.toBeNull();
    expect(row!.address).toBe("0x33".padEnd(42, "3"));
  });
});

describe("TronGrid pagination validation", () => {
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
    const fetchMock = mockFetch([{
      match: "api.trongrid.io/v1/contracts/",
      outcomes: [
        { body: { success: true, data: [], meta: { links: { next } } }, status: 200 },
        { body: { success: true, data: [], meta: { links: { next } } }, status: 200 },
      ],
    }], { requireMatch: true });

    const result = await fetchTronEventsIncremental(config, "secret", 0, makeRunBudget(), noopLimiter);

    expect(result).toMatchObject({ apiError: true, incomplete: true, providerCalls: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchTronEventsIncremental cursor safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds malformed address evidence then consumes only after durable third-scan quarantine", async () => {
    const base = findConfig("usdt-tether");
    const config = { ...base, events: [base.events.find((event) => event.signature.startsWith("AddedBlackList"))!] };
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)");
    const db = { prepare(sql: string) {
      let args: (string | number)[] = [];
      return { bind(...values: (string | number)[]) { args = values; return this; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async run() { return sqlite.prepare(sql).run(...args); } };
    } } as unknown as D1Database;
    const timestamp = 1_700_000_000_000;
    const valid = { block_number: 100, block_timestamp: timestamp, transaction_id: "ab".repeat(32),
      event_index: 0, event_name: "AddedBlackList", result: { _blackListedUser: "0x" + "11".repeat(20) } };
    mockFetch([{ match: "api.trongrid.io/v1/contracts/", body: { success: true, data: [
      valid, { ...valid, block_timestamp: timestamp + 1000, event_index: 1, result: {} },
      { ...valid, block_timestamp: timestamp + 2000, event_index: 2 },
    ], meta: {} } }], { requireMatch: true });
    const deadline = Date.now() + 600_000;
    for (let scan = 1; scan <= 3; scan++) {
      const result = await fetchTronEventsIncremental(config, null, 0,
        { ...makeRunBudget(), deadlineMs: deadline + scan }, noopLimiter, undefined, db);
      expect(result.rows.map((row) => row.timestamp)).toEqual(scan < 3 ? [timestamp / 1000] : [timestamp / 1000, timestamp / 1000 + 2]);
      if (scan < 3) expect(result.scannedToTimestamp).toBe(timestamp + 999);
      else expect(result.scannedToTimestamp).toBeGreaterThan(timestamp + 2000);
      expect(result.incomplete).toBe(scan < 3);
    }
    const state = JSON.parse(String(sqlite.prepare("SELECT value FROM cache").get()!.value));
    expect(state).toMatchObject({ quarantined: true, attempts: 3, reason: "invalid-address" });
    sqlite.close();
  });

  it("uses confirmed, safe-head-bounded timestamp filters", async () => {
    const baseConfig = findConfig("usdt-tether");
    const config: ContractEventConfig = { ...baseConfig, events: [baseConfig.events[0]!] };
    const lastTimestampMs = Date.now() - 86_400_000;
    const fetchMock = mockFetch([{
      match: "api.trongrid.io/v1/contracts/",
      body: { success: true, data: [], meta: {} },
    }], { requireMatch: true });

    await fetchTronEventsIncremental(config, null, lastTimestampMs, makeRunBudget(), noopLimiter);

    const requested = new URL(fetchMock.getHistory()[0]!.url);
    expect(requested.searchParams.get("min_block_timestamp")).toBe(String(lastTimestampMs));
    expect(Number(requested.searchParams.get("max_block_timestamp"))).toBeLessThanOrEqual(Date.now() - 15 * 60_000);
    expect(requested.searchParams.get("only_confirmed")).toBe("true");
  });

  it("marks the scan incomplete when a later event family fails", async () => {
    const config = findConfig("usdt-tether");
    mockFetch([{
      match: "api.trongrid.io/v1/contracts/",
      outcomes: [
        {
          body: {
            success: true,
            data: [{
              block_number: 100,
              block_timestamp: 1_700_000_000_000,
              transaction_id: "34".repeat(32),
              event_index: 0,
              event_name: "AddedBlackList",
              result: { _blackListedUser: "0xaa".padEnd(42, "a") },
            }],
            meta: {},
          },
        },
        { body: "server error", status: 500 },
      ],
    }], { requireMatch: true });

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
    const fetchMock = mockFetch([{
      match: "api.trongrid.io/v1/contracts/",
      body: {
        success: true,
        data: [],
        meta: {
          links: {
            next: `https://api.trongrid.io/v1/contracts/${config.contractAddress}/events?event_name=${firstEvent.signature.split("(")[0]}&fingerprint=page-2`,
          },
        },
      },
    }], { requireMatch: true });

    const result = await fetchTronEventsIncremental(config, null, 0, makeRunBudget(1), noopLimiter);

    expect(result.rows).toHaveLength(0);
    expect(result.apiError).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
