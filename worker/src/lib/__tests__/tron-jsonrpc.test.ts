import { afterEach, describe, expect, it, vi } from "vitest";
import { TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES, TRON_RPC_MAX_RESPONSE_BYTES,
  TRON_SOLID_HEAD_MAX_AGE_MS, TRON_SOLID_HEAD_MAX_FUTURE_MS } from "@shared/lib/tron-jsonrpc";
import { createDwellirNativeCapability } from "../dwellir-native";
import type { RateLimitedFetch } from "../evm-logs";
import { TronJsonRpcReader } from "../tron-jsonrpc";
import * as providerBudget from "../rpc-provider-budget";

const ADDRESS = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const TOPIC = "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc";
const quantity = (value: number) => `0x${value.toString(16)}`;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

interface RpcRequest { id: number; method: string; params: unknown[] }
interface Filter { fromBlock: string; toBlock: string; address?: string; topics?: string[][] }

function log(blockNumber: number, logIndex = 0, transactionIndex = 0) {
  return {
    address: ADDRESS, topics: [TOPIC], data: "0x", removed: false,
    blockNumber: quantity(blockNumber), blockHash: hash(blockNumber),
    transactionHash: hash(100 + transactionIndex), transactionIndex: quantity(transactionIndex), logIndex: quantity(logIndex),
  };
}

function harness(options: {
  head?: number;
  tip?: number;
  limit?: number;
  native?: boolean;
  gridAllowed?: boolean;
  rateLimit?: RateLimitedFetch;
  nowMs?: number;
  deadlineMs?: number;
  timestamp?: (number: number) => number;
  respond?: (url: string, body: RpcRequest) => Response | undefined;
  logs?: (filter: Filter, request: RpcRequest) => Response | unknown[];
} = {}) {
  const head = options.head ?? 25_000;
  const timestamp = options.timestamp ?? ((number: number) => 1_000 + number * 3);
  vi.spyOn(Date, "now").mockReturnValue(options.nowMs ?? timestamp(head) * 1000);
  const ranges: Array<[number, number]> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const request: RpcRequest = JSON.parse(String(init?.body));
    const custom = options.respond?.(url, request);
    if (custom) return custom;
    if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
      blockID: hash(head).slice(2), block_header: { raw_data: { number: head, timestamp: timestamp(head) * 1000 } },
    });
    let result: unknown;
    if (request.method === "eth_blockNumber") result = quantity(options.tip ?? head + 20);
    else if (request.method === "eth_getBlockByNumber") {
      const number = Number(request.params[0]);
      result = { number: quantity(number), hash: hash(number), timestamp: quantity(timestamp(number)) };
    } else if (request.method === "eth_getLogs") {
      const filter = request.params[0] as Filter;
      ranges.push([Number(filter.fromBlock), Number(filter.toBlock)]);
      result = options.logs?.(filter, request) ?? [];
      if (result instanceof Response) return result;
    } else throw new Error(`Unexpected test RPC method: ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(providerBudget, "recordDwellirCredits").mockImplementation(() => {});
  const budget = { count: 0, limit: options.limit ?? 100 };
  const controller = new AbortController();
  const reader = new TronJsonRpcReader({
    dwellirNative: options.native === false ? undefined : createDwellirNativeCapability("test-dwellir-key"),
    trongridApiKey: "test-trongrid-key", trongridAllowed: options.gridAllowed ?? false,
    budget, deadlineMs: options.deadlineMs ?? Date.now() + 30_000, signal: controller.signal, rateLimit: options.rateLimit ?? ((fn) => fn()),
  });
  return { reader, budget, controller, fetcher, ranges };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Tron JSON-RPC contiguous log coverage", () => {
  it("reuses the fallback head and failed-provider state across scans", async () => {
    const { reader, budget } = harness({ gridAllowed: true, respond: (url, request) =>
      url.includes("dwellir") && request.method === "eth_getLogs" ? new Response("unavailable", { status: 503 }) : undefined,
    });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 2)).toMatchObject({ complete: true });
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 2 });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 3, 4)).toMatchObject({ complete: true });
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 3 });
    expect(budget.count).toBe(7);
    expect(reader.failures).toEqual(["dwellir:tron-rpc-transport-error"]);
  });

  it("bounds every inclusive span to 10,000 and clamps the scan to the solidified head", async () => {
    const { reader, budget, ranges } = harness();
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 30_000)).toEqual({
      logs: [], scannedToBlock: 25_000, complete: true, reason: null, maxSplitDepth: 0,
    });
    expect(ranges).toEqual([[1, 10_000], [10_001, 20_000], [20_001, 25_000]]);
    expect(budget.count).toBe(6);
    expect(reader.calls).toEqual({ dwellir: 6, trongrid: 0 });
    expect(providerBudget.recordDwellirCredits).toHaveBeenCalledTimes(6);
  });

  it("splits range errors left first and retains only the proven frontier when the right half fails", async () => {
    const { reader, ranges } = harness({ logs: (filter, request) => {
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      if (from === 1 && to === 4) return Response.json({ jsonrpc: "2.0", id: request.id,
        error: { code: -32005, message: "block range too large" } });
      if (from === 3) return Response.json({ jsonrpc: "2.0", id: request.id,
        error: { code: -32603, message: "unavailable" } });
      return [log(1)];
    } });
    const result = await reader.getLogs(ADDRESS, [TOPIC], 1, 4);
    expect(result).toMatchObject({ scannedToBlock: 2, complete: false,
      reason: "tron-rpc-providers-unavailable", maxSplitDepth: 1 });
    expect(result.logs.map((entry) => entry.blockNumber)).toEqual([1]);
    expect(ranges).toEqual([[1, 4], [1, 2], [3, 4]]);
  });

  it("splits oversized response bodies without increasing the intake cap", async () => {
    const responses: Response[] = [];
    const { reader, ranges } = harness({ logs: (filter) => {
      if (Number(filter.toBlock) - Number(filter.fromBlock) === 3) {
        const response = new Response(" ".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1));
        responses.push(response);
        return response;
      }
      return [log(Number(filter.fromBlock))];
    } });
    const result = await reader.getLogs(ADDRESS, [TOPIC], 1, 4);
    expect(result).toMatchObject({ scannedToBlock: 4, complete: true, reason: null, maxSplitDepth: 1 });
    expect(result.logs.map((entry) => entry.blockNumber)).toEqual([1, 3]);
    expect(ranges).toEqual([[1, 4], [1, 2], [3, 4]]);
    expect(responses[0].bodyUsed).toBe(true);
  });

  it("stops at an unsplittable single block without advancing over it", async () => {
    const { reader, ranges } = harness({ logs: (_filter, request) => Response.json({
      jsonrpc: "2.0", id: request.id, error: { code: -32005, message: "result limit" },
    }) });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 4, 4)).toMatchObject({
      logs: [], scannedToBlock: 3, complete: false, reason: "tron-rpc-provider-error", maxSplitDepth: 0,
    });
    expect(ranges).toEqual([[4, 4]]);
  });

  it.each(["range", "body"])("retains the provider failure for a terminal single-block %s limit", async (kind) => {
    const { reader } = harness({ native: false, gridAllowed: true, logs: (_filter, request) => kind === "body"
      ? new Response("x".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1))
      : Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32005, message: "result limit" } }),
    });
    const result = await reader.getLogs(ADDRESS, [TOPIC], 4, 4);
    expect(result).toMatchObject({ complete: false, scannedToBlock: 3 });
    expect(reader.failures).toEqual([`trongrid:${result.reason}`]);
  });

  it("counts head reads and split attempts against the same budget", async () => {
    const { reader, budget, fetcher, ranges } = harness({ limit: 4 });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 20_000)).toMatchObject({
      scannedToBlock: 10_000, complete: false, reason: "tron-rpc-budget-exhausted",
    });
    expect(ranges).toEqual([[1, 10_000]]);
    expect(budget.count).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not manufacture an above-head frontier for a future starting block", async () => {
    const { reader, ranges } = harness({ head: 10 });
    const result = await reader.getLogs(ADDRESS, [TOPIC], 20, 30);
    expect(result.scannedToBlock).toBeLessThanOrEqual(10);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe("tron-rpc-above-solid-head");
    expect(ranges).toEqual([]);
  });

  it.each([
    { address: "not-an-address", topics: [TOPIC], from: 1, to: 2 },
    { address: ADDRESS, topics: ["0x12"], from: 1, to: 2 },
    { address: ADDRESS, topics: [], from: 1, to: 2 },
    { address: ADDRESS, topics: Array(17).fill(TOPIC), from: 1, to: 2 },
    { address: ADDRESS, topics: [TOPIC], from: -1, to: 2 },
    { address: ADDRESS, topics: [TOPIC], from: 3, to: 2 },
    { address: ADDRESS, topics: [TOPIC], from: 1, to: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed filters before network intake: $from..$to $address", async ({ address, topics, from, to }) => {
    const { reader, fetcher } = harness();
    await expect(reader.getLogs(address, topics, from, to)).rejects.toThrow("tron-rpc-invalid-filter");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { address: `0x${"ab".repeat(20)}` }, { topics: [hash(7)] }, { blockNumber: "0x14" },
    { removed: true }, { data: "0x1" }, { transactionIndex: "0xffffffffffffffff" }, { blockHash: "0x12" },
  ])("rejects mismatching or malformed log data without admitting the range: %j", async (patch) => {
    const { reader } = harness({ logs: () => [{ ...log(10), ...patch }] });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 10, 14)).toMatchObject({
      logs: [], scannedToBlock: 9, complete: false, reason: "tron-rpc-providers-unavailable",
    });
    expect(reader.failures).toContain("dwellir:tron-rpc-invalid-log");
  });

  it("rejects duplicate block-global log identities", async () => {
    const { reader } = harness({ logs: () => [log(10), log(10)] });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 10, 10)).toMatchObject({
      logs: [], scannedToBlock: 9, complete: false, reason: "tron-rpc-providers-unavailable",
    });
    expect(reader.failures).toContain("dwellir:tron-rpc-invalid-log");
  });
});

describe("Tron JSON-RPC transport and head evidence", () => {
  it.each(["too many requests", "limit exceeded", "rate limit exceeded", "range rejected: request rate limit exceeded", "unavailable", ""])(
    "falls back without splitting a -32005 provider error: %s", async (message) => {
      const { reader, budget, ranges } = harness({ gridAllowed: true, respond: (url, request) =>
        url.includes("dwellir") && request.method === "eth_getLogs"
          ? Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32005, message } }) : undefined,
      });
      expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 10_000)).toMatchObject({
        complete: true, scannedToBlock: 10_000, maxSplitDepth: 0,
      });
      expect(ranges).toEqual([[1, 10_000]]);
      expect(budget.count).toBe(6);
      expect(reader.calls).toEqual({ dwellir: 4, trongrid: 2 });
      expect(reader.failures).toEqual(["dwellir:tron-rpc-provider-error"]);
    },
  );

  it.each(["body", "range"])("uses fallback for a single-block %s limit that cannot split", async (kind) => {
    const { reader } = harness({ gridAllowed: true, respond: (url, request) =>
      url.includes("dwellir") && request.method === "eth_getLogs"
        ? kind === "body" ? new Response(" ".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1))
          : Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32005, message: "result limit" } }) : undefined,
    });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 1)).toMatchObject({
      complete: true, scannedToBlock: 1, maxSplitDepth: 0,
    });
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 2 });
    expect(reader.failures).toEqual([kind === "body" ? "dwellir:tron-rpc-body-too-large" : "dwellir:tron-rpc-provider-error"]);
  });

  it.each([
    [TRON_SOLID_HEAD_MAX_AGE_MS, true, null],
    [TRON_SOLID_HEAD_MAX_AGE_MS + 1, false, "tron-rpc-stale-solid-head"],
    [-TRON_SOLID_HEAD_MAX_FUTURE_MS, true, null],
    [-TRON_SOLID_HEAD_MAX_FUTURE_MS - 1, false, "tron-rpc-future-solid-head"],
  ] as const)("checks solid-head age %sms against the collection clock", async (ageMs, accepted, reason) => {
    const { reader, ranges } = harness({ nowMs: 76_000_000 + ageMs });
    if (accepted) await expect(reader.getSolidHead()).resolves.toMatchObject({ number: 25_000 });
    else {
      await expect(reader.getSolidHead()).rejects.toThrow(reason!);
      expect(reader.failures).toEqual([`dwellir:${reason}`]);
      expect(ranges).toEqual([]);
    }
  });

  it("rejects stale Dwellir evidence and validates a fresh fallback solid head", async () => {
    const { reader } = harness({ gridAllowed: true, respond: (url) =>
      url.includes("dwellir") && url.endsWith("/walletsolidity/getnowblock")
        ? Response.json({ blockID: hash(25_000).slice(2), block_header: {
          raw_data: { number: 25_000, timestamp: 76_000_000 - TRON_SOLID_HEAD_MAX_AGE_MS - 1 },
        } }) : undefined,
    });
    await expect(reader.getLogs(ADDRESS, [TOPIC], 1, 2)).resolves.toMatchObject({ complete: true });
    expect(reader.failures).toEqual(["dwellir:tron-rpc-stale-solid-head"]);
    expect(reader.calls).toEqual({ dwellir: 1, trongrid: 4 });
  });

  it("retains both provider reasons when all solid heads are stale", async () => {
    const { reader, fetcher } = harness({ gridAllowed: true, nowMs: 76_000_000 + TRON_SOLID_HEAD_MAX_AGE_MS + 1 });
    await expect(reader.getLogs(ADDRESS, [TOPIC], 1, 2)).rejects.toThrow("tron-rpc-stale-solid-head");
    expect(reader.failures).toEqual(["dwellir:tron-rpc-stale-solid-head", "trongrid:tron-rpc-stale-solid-head"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revalidates and refreshes an expired cached solid head", async () => {
    let currentHead = 25_000;
    const { reader, fetcher } = harness({ deadlineMs: 80_000_000, respond: (url, request) => {
      if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
        blockID: hash(currentHead).slice(2), block_header: { raw_data: {
          number: currentHead, timestamp: (1000 + 3 * currentHead) * 1000,
        } },
      });
      if (request.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: request.id, result: quantity(currentHead + 20) });
      return undefined;
    } });
    await expect(reader.getSolidHead()).resolves.toMatchObject({ number: 25_000 });
    vi.spyOn(Date, "now").mockReturnValue(76_000_000 + TRON_SOLID_HEAD_MAX_AGE_MS + 1);
    currentHead = 25_201;
    await expect(reader.getSolidHead()).resolves.toMatchObject({ number: currentHead });
    expect(reader.failures).toEqual(["cached:tron-rpc-stale-solid-head"]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each([
    [TRON_SOLID_HEAD_MAX_AGE_MS + 1, "tron-rpc-stale-solid-head"],
    [-TRON_SOLID_HEAD_MAX_FUTURE_MS - 1, "tron-rpc-future-solid-head"],
  ] as const)("surfaces cached freshness failure %s when both refresh providers fail", async (ageMs, reason) => {
    let failRefresh = false;
    const { reader, fetcher } = harness({ gridAllowed: true, deadlineMs: 80_000_000,
      respond: () => failRefresh ? new Response("unavailable", { status: 503 }) : undefined,
    });
    await expect(reader.getSolidHead()).resolves.toMatchObject({ number: 25_000 });
    vi.spyOn(Date, "now").mockReturnValue(76_000_000 + ageMs);
    failRefresh = true;
    await expect(reader.getSolidHead()).rejects.toThrow(reason);
    expect(reader.failures).toEqual([`cached:${reason}`, "dwellir:tron-rpc-transport-error", "trongrid:tron-rpc-transport-error"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("does not reuse an older attempt's freshness failure for an unrelated head failure", async () => {
    let failGridHead = false;
    const { reader } = harness({ gridAllowed: true, respond: (url, request) => {
      if (url.includes("dwellir") && url.endsWith("/walletsolidity/getnowblock")) return Response.json({
        blockID: hash(25_000).slice(2), block_header: { raw_data: {
          number: 25_000, timestamp: 76_000_000 - TRON_SOLID_HEAD_MAX_AGE_MS - 1,
        } },
      });
      if (failGridHead || request.method === "eth_blockNumber") return new Response("unavailable", { status: 503 });
      return undefined;
    } });
    await expect(reader.getSolidHead()).rejects.toThrow("tron-rpc-stale-solid-head");
    failGridHead = true;
    await expect(reader.getSolidHead()).rejects.toThrow("tron-rpc-providers-unavailable");
  });

  it("falls back to TronGrid with its own header and stops retrying the failed primary in this reader", async () => {
    const { reader, fetcher, budget } = harness({ gridAllowed: true,
      respond: (url) => url.includes("dwellir.com") ? new Response("unavailable", { status: 503 }) : undefined,
    });
    await expect(reader.getLogs(ADDRESS, [TOPIC], 10, 20)).resolves.toMatchObject({ complete: true });
    expect(reader.calls).toEqual({ dwellir: 1, trongrid: 4 });
    expect(budget.count).toBe(5);
    expect(fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === "eth_blockNumber")).toHaveLength(1);
    for (const [url, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      if (String(url).includes("dwellir.com")) {
        expect(headers.get("X-Api-Key")).toBe("test-dwellir-key");
        expect(headers.has("TRON-PRO-API-KEY")).toBe(false);
      } else {
        expect(headers.get("TRON-PRO-API-KEY")).toBe("test-trongrid-key");
        expect(headers.has("X-Api-Key")).toBe(false);
      }
    }
  });

  it("retries malformed successful primary log responses through TronGrid", async () => {
    const { reader, budget } = harness({ gridAllowed: true,
      respond: (url, request) => url.includes("dwellir.com") && request.method === "eth_getLogs"
        ? Response.json({ jsonrpc: "2.0", id: request.id, result: [{ ...log(10), address: "0x12" }] })
        : undefined,
      logs: () => [log(10)],
    });
    const result = await reader.getLogs(ADDRESS, [TOPIC], 10, 10);
    expect(result).toMatchObject({ complete: true, scannedToBlock: 10, reason: null });
    expect(result.logs).toHaveLength(1);
    expect(reader.failures).toEqual(["dwellir:tron-rpc-invalid-log"]);
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 2 });
    expect(budget.count).toBe(6);
  });

  it.each(["behind", "unavailable"])("does not accept empty fallback coverage when TronGrid's own head is %s", async (state) => {
    const { reader, fetcher, budget } = harness({ gridAllowed: true, respond: (url, request) => {
      if (url.includes("dwellir") && request.method === "eth_getLogs"
        && Number((request.params[0] as Filter).fromBlock) === 10_001) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("trongrid") && request.method === "eth_blockNumber") {
        return Response.json({ jsonrpc: "2.0", id: request.id, ...(state === "behind"
          ? { result: quantity(15_000) } : { error: { code: -32603, message: "unavailable" } }) });
      }
      return undefined;
    } });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 20_000)).toMatchObject({
      logs: [], scannedToBlock: 10_000, complete: false, reason: "tron-rpc-providers-unavailable",
    });
    expect(reader.calls).toEqual({ dwellir: 5, trongrid: 1 });
    expect(budget.count).toBe(6);
    expect(reader.failures).toContain(state === "behind"
      ? "trongrid:tron-rpc-fallback-head-behind" : "trongrid:tron-rpc-provider-error");
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).includes("trongrid")
      && JSON.parse(String(init?.body)).method === "eth_getLogs")).toHaveLength(0);
  });

  it("charges fallback-head evidence before admitting logs under the active scan budget", async () => {
    const { reader, fetcher, budget } = harness({ gridAllowed: true, limit: 5,
      respond: (url, request) => url.includes("dwellir") && request.method === "eth_getLogs"
        ? new Response("unavailable", { status: 503 }) : undefined,
    });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 2)).toMatchObject({
      logs: [], scannedToBlock: 0, complete: false, reason: "tron-rpc-budget-exhausted",
    });
    expect(budget.count).toBe(5);
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 1 });
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).includes("trongrid")
      && JSON.parse(String(init?.body)).method === "eth_getLogs")).toHaveLength(0);
  });

  it("checks the fallback head outside the serial limiter callback", async () => {
    let active = false;
    const { reader } = harness({ gridAllowed: true,
      respond: (url, request) => url.includes("dwellir") && request.method === "eth_getLogs"
        ? new Response("unavailable", { status: 503 }) : undefined,
      rateLimit: async (fn) => {
        if (active) throw new Error("nested serial limiter");
        active = true;
        try { return await fn(); } finally { active = false; }
      },
    });
    expect(await reader.getLogs(ADDRESS, [TOPIC], 1, 2)).toMatchObject({ complete: true });
    expect(reader.calls).toEqual({ dwellir: 4, trongrid: 2 });
  });

  it("refuses an inconsistent solidified header", async () => {
    const { reader } = harness({ respond: (_url, request) => request.method === "eth_getBlockByNumber"
      ? Response.json({ jsonrpc: "2.0", id: request.id, result: {
        number: request.params[0], hash: hash(99), timestamp: quantity(76_000),
      } }) : undefined });
    await expect(reader.getSolidHead()).rejects.toThrow("tron-rpc-solid-head-mismatch");
  });

  it("refuses a JSON-RPC tip behind the claimed solidified head", async () => {
    const { reader } = harness({ head: 10, tip: 9 });
    await expect(reader.getSolidHead()).rejects.toThrow("tron-rpc-providers-unavailable");
    expect(reader.failures).toContain("dwellir:tron-rpc-head-mismatch");
  });

  it("finds the first block at or after a timestamp using actual headers and reuses the head", async () => {
    const times = [100, 103, 109, 109, 115, 121, 130, 140, 146];
    const { reader, fetcher } = harness({ head: 8, timestamp: (number) => times[number] });
    expect(await reader.findBlockAtTimestamp(109_000)).toBe(2);
    expect(await reader.findBlockAtTimestamp(109_001)).toBe(4);
    expect(await reader.findBlockAtTimestamp(146_001)).toBe(9);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/walletsolidity/getnowblock"))).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === "eth_blockNumber")).toHaveLength(1);
  });

  it("uses two nearby headers to locate a nominal six-hour cursor on a mature chain", async () => {
    const head = 87_500_000;
    const { reader, fetcher } = harness({ head });
    expect(await reader.findBlockAtTimestamp((1000 + (head - 7200) * 3) * 1000)).toBe(head - 7200);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each([2, 4])("widens a missed nominal bracket for an observed %ss block interval", async (interval) => {
    const head = 100_000;
    const { reader, fetcher } = harness({ head, timestamp: (number) => 1000 + number * interval });
    expect(await reader.findBlockAtTimestamp((1000 + 92_800 * interval) * 1000 + 1)).toBe(92_801);
    const reads = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter((request) => request.method === "eth_getBlockByNumber").map((request) => Number(request.params[0]));
    expect(reads.every((number) => number > 80_000)).toBe(true);
  });

  it("does not fetch or charge after parent cancellation", async () => {
    const { reader, controller, fetcher, budget } = harness();
    controller.abort(new Error("test-cancelled"));
    await expect(reader.getSolidHead()).rejects.toThrow("test-cancelled");
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.count).toBe(0);
  });
});

describe("Tron transaction-local event identities", () => {
  it.each([true, false])("streams full block context over128KiB with native=%s", async (native) => {
    const context = Array.from({ length: 400 }, (_, index) => log(2, index));
    const { reader } = harness({ native, gridAllowed: !native, head: 3, logs: () => context });
    expect(JSON.stringify(context).length).toBeGreaterThan(TRON_RPC_MAX_RESPONSE_BYTES);
    const positions = await reader.getTransactionLogIndices(2);
    expect(positions.size).toBe(400);
    expect(positions.get(399)).toBe(399);
  });

  it.each([true, false])("rejects streamed block context beyond2MiB with native=%s", async (native) => {
    let cancelled = false;
    const { reader } = harness({ native, gridAllowed: !native, head: 3, logs: () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES / 2)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Length": "1" } }) });
    await expect(reader.getTransactionLogIndices(2)).rejects.toThrow("tron-rpc-body-too-large");
    expect(cancelled).toBe(true);
    expect(reader.failures).toEqual([`${native ? "dwellir" : "trongrid"}:tron-rpc-body-too-large`]);
  });

  it("derives local ordinals from all logs, including preceding logs from another contract", async () => {
    const { reader, fetcher } = harness({ head: 3, logs: (filter) => filter.address ? [log(2, 2, 1)] : [
      log(2, 0, 0), { ...log(2, 1, 1), address: `0x${"ab".repeat(20)}` }, log(2, 2, 1),
    ] });
    const selected = (await reader.getLogs(ADDRESS, [TOPIC], 2, 2)).logs;
    expect(await reader.getTransactionLogIndices(2, selected)).toEqual(new Map([[0, 0], [1, 0], [2, 1]]));
    const request = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .find((entry) => entry.method === "eth_getLogs" && !entry.params[0].address);
    expect(request.params).toEqual([{ fromBlock: "0x2", toBlock: "0x2" }]);
  });

  it.each([[], [{ ...log(2), data: "0x00" }]])("rejects block context that does not reproduce a selected event %#", async (...context) => {
    const { reader } = harness({ head: 3, logs: (filter) => filter.address ? [log(2)] : context });
    const selected = (await reader.getLogs(ADDRESS, [TOPIC], 2, 2)).logs;
    await expect(reader.getTransactionLogIndices(2, selected)).rejects.toThrow("tron-rpc-block-context-mismatch");
  });

  it.each([
    [log(2, 0), log(2, 2)],
    [{ ...log(2), blockHash: hash(99) }],
    [log(2, 0, 1), log(2, 1, 0)],
    [log(2, 0, 1), { ...log(2, 1, 1), transactionHash: hash(99) }],
    [log(2, 0, 1), { ...log(2, 1, 2), transactionHash: hash(101) }],
    [log(2, 0, 1), log(2, 1, 2), { ...log(2, 2, 3), transactionHash: hash(101) }],
  ])("fails closed on incomplete or inconsistent block context %#", async (...logs) => {
    const { reader } = harness({ head: 3, logs: () => logs });
    await expect(reader.getTransactionLogIndices(2)).rejects.toThrow("tron-rpc-incomplete-block-context");
  });

  it("refuses transaction identity context above the solidified head", async () => {
    const { reader, ranges } = harness({ head: 3 });
    await expect(reader.getTransactionLogIndices(4)).rejects.toThrow("tron-rpc-above-solid-head");
    expect(ranges).toEqual([]);
  });
});
