import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_CONFIGS } from "../../../lib/blacklist-contracts";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import { TronJsonRpcReader, type TronRpcLog } from "../../../lib/tron-jsonrpc";
import * as providerBudget from "../../../lib/rpc-provider-budget";
import { fetchTronEventsWithRpc, parseTronRpcEvent } from "../tron-rpc-source";
import { parseTronEvent, TRON_INDEXING_SAFETY_MS } from "../tron-source";
import captured from "./fixtures/tron-rpc-events.json";

const usdt = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "usdt-tether" && config.chain.chainId === "tron")!;
const usd1 = CONTRACT_CONFIGS.find((config) => config.stablecoinId === "usd1-world-liberty-financial" && config.chain.chainId === "tron")!;
const quantity = (value: number) => `0x${value.toString(16)}`;
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
const BASE_SEC = 1_790_000_000;
const blockTime = (number: number) => BASE_SEC + number * 3;
const affectedAddress = `0x${"ab".repeat(20)}`;
const addressWord = `0x${"0".repeat(24)}${affectedAddress.slice(2)}`;

function normalize(log: (typeof captured)[number]["rpcLog"]): TronRpcLog {
  return { address: log.address, topics: log.topics, data: log.data, blockHash: log.blockHash,
    transactionHash: log.transactionHash, blockNumber: Number(log.blockNumber),
    transactionIndex: Number(log.transactionIndex), logIndex: Number(log.logIndex) };
}

function rawLog(blockNumber: number, eventIndex = 0) {
  return { address: captured[0].rpcLog.address, topics: [usdt.events[eventIndex].topicHash, addressWord],
    data: eventIndex === 2 ? `0x${(25_000_000).toString(16).padStart(64, "0")}` : "0x",
    removed: false, blockNumber: quantity(blockNumber), blockHash: hash(blockNumber),
    transactionHash: hash(1_000 + blockNumber), transactionIndex: "0x1", logIndex: "0x2" };
}

interface RpcRequest { id: number; method: string; params: unknown[] }
interface Filter { fromBlock: string; toBlock: string; address?: string; topics?: string[][] }

function harness(options: {
  head?: number;
  nowMs?: number;
  limit?: number;
  expired?: boolean;
  runtimeBudgetMs?: number;
  gridAllowed?: boolean;
  eventApiAllowed?: boolean;
  eventApiData?: object[];
  logs?: ReturnType<typeof rawLog>[];
  respond?: (url: string, request: RpcRequest) => Response | undefined;
} = {}) {
  const safeBlock = options.head ?? 8;
  const head = safeBlock + TRON_INDEXING_SAFETY_MS / 3000;
  const nowMs = options.nowMs ?? blockTime(head) * 1000;
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  const logs = options.logs ?? [rawLog(2), rawLog(4, 2)];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/contracts/")) {
      const eventName = new URL(url).searchParams.get("event_name");
      return Response.json({ success: true, data: eventName === "AddedBlackList" ? options.eventApiData ?? [] : [] });
    }
    const request: RpcRequest = JSON.parse(String(init?.body));
    const custom = options.respond?.(url, request);
    if (custom) return custom;
    if (url.endsWith("/walletsolidity/getnowblock")) return Response.json({
      blockID: hash(head).slice(2), block_header: { raw_data: { number: head, timestamp: blockTime(head) * 1000 } },
    });
    let result: unknown;
    if (request.method === "eth_blockNumber") result = quantity(head + 20);
    else if (request.method === "eth_getBlockByNumber") {
      const number = Number(request.params[0]);
      result = { number: quantity(number), hash: hash(number), timestamp: quantity(blockTime(number)) };
    } else if (request.method === "eth_getLogs") {
      const filter = request.params[0] as Filter;
      const selected = logs.filter((log) => Number(log.blockNumber) >= Number(filter.fromBlock)
        && Number(log.blockNumber) <= Number(filter.toBlock));
      result = filter.address ? selected : selected.flatMap((log) => [
        { ...log, address: `0x${"12".repeat(20)}`, logIndex: "0x0", transactionIndex: "0x0", transactionHash: hash(99) },
        { ...log, address: `0x${"34".repeat(20)}`, logIndex: "0x1" }, log,
      ]);
    } else throw new Error(`Unexpected RPC ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(providerBudget, "recordDwellirCredits").mockImplementation(() => {});
  const signal = new AbortController().signal;
  const runBudget = { subrequestBudget: { count: 0, limit: options.limit ?? 100 },
    deadlineMs: nowMs + (options.expired ? -1 : options.runtimeBudgetMs ?? 60_000), minimumConfigWindowMs: 0 };
  const reader = new TronJsonRpcReader({ dwellirNative: createDwellirNativeCapability("test-dwellir-key"),
    trongridApiKey: "test-trongrid-key", trongridAllowed: options.gridAllowed ?? false,
    budget: runBudget.subrequestBudget, deadlineMs: runBudget.deadlineMs, signal, rateLimit: (fn) => fn() });
  const scan = (lastTimestampMs = blockTime(2) * 1000) => fetchTronEventsWithRpc({
    config: usdt, apiKey: "test-trongrid-key", lastTimestampMs, runBudget,
    rateLimit: (fn) => fn(), signal, reader, eventApiAllowed: options.eventApiAllowed ?? false,
  });
  return { scan, reader, fetcher, runBudget };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Tron freeze JSON-RPC row parity", () => {
  it.each(captured)("preserves the captured $event event-API identity, amount and timestamp", (fixture) => {
    const log = normalize(fixture.rpcLog);
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fixture.tronGridEvent.result)) {
      if (typeof value !== "string") throw new Error(`Invalid captured result field: ${key}`);
      fields[key] = value;
    }
    const legacy = parseTronEvent(usdt, { ...fixture.tronGridEvent, result: fields });
    const row = parseTronRpcEvent(usdt, log, Number(fixture.blockHeader.timestamp), fixture.tronGridEvent.event_index);
    expect(row).toEqual({ ...legacy, transaction_index: log.transactionIndex, event_topic0: log.topics[0] });
    expect(row.id).toBe(`tron-${fixture.tronGridEvent.transaction_id}-1`);
    expect(log.logIndex).not.toBe(fixture.tronGridEvent.event_index);
    expect(row.explorer_tx_url).toBe(legacy?.explorer_tx_url);
  });

  it.each(usd1.events)("decodes the USD1 affected account in topics[2] for $signature", (event) => {
    const log: TronRpcLog = { ...normalize(captured[0].rpcLog),
      topics: [event.topicHash, `0x${"0".repeat(24)}${"cd".repeat(20)}`, addressWord],
      data: event.hasAmount ? `0x${"0".repeat(62)}19` : "0x" };
    const legacy = parseTronEvent(usd1, { block_number: log.blockNumber, block_timestamp: BASE_SEC * 1000,
      transaction_id: log.transactionHash.slice(2), event_index: 1,
      event_name: event.signature.split("(")[0], result: { account: affectedAddress, _balance: "25" } });
    expect(parseTronRpcEvent(usd1, log, BASE_SEC, 1)).toEqual({ ...legacy,
      transaction_index: log.transactionIndex, event_topic0: event.topicHash });
  });

  it.each([
    { eventName: "FrozenAccountDrained", amountKey: "amount" },
    { eventName: "FrozenAccountDrained", amountKey: "2" },
    { eventName: "FrozenFundsReallocated", amountKey: "amount" },
    { eventName: "FrozenFundsReallocated", amountKey: "3" },
  ])("matches USD1 RPC amounts using event-API $eventName field $amountKey", ({ eventName, amountKey }) => {
    const event = usd1.events.find((event) => event.signature.startsWith(`${eventName}(`))!;
    const log: TronRpcLog = { ...normalize(captured[0].rpcLog),
      topics: [event.topicHash, `0x${"0".repeat(24)}${"cd".repeat(20)}`, addressWord],
      data: `0x${"0".repeat(62)}19` };
    const fields: Record<string, string> = { account: affectedAddress, "0": `0x${"cd".repeat(20)}`,
      "1": affectedAddress, ...(eventName === "FrozenFundsReallocated" ? { "2": `0x${"ef".repeat(20)}` } : {}),
      [amountKey]: "25" };
    const legacy = parseTronEvent(usd1, { block_number: log.blockNumber, block_timestamp: BASE_SEC * 1000,
      transaction_id: log.transactionHash.slice(2), event_index: 1, event_name: eventName, result: fields });
    const row = parseTronRpcEvent(usd1, log, BASE_SEC, 1);
    expect(legacy?.amount_status).toBe("resolved");
    expect(row).toEqual({ ...legacy, transaction_index: log.transactionIndex, event_topic0: event.topicHash });
  });

  it.each([
    { _balance: "25", _value: "50", amount: "75", "2": "100" },
    { _balance: "", _value: "25", amount: "50", "2": "75" },
  ])("retains explicit legacy amount-field precedence over USD1 fallbacks: %j", (fields) => {
    const event = { block_number: 2, block_timestamp: BASE_SEC * 1000, transaction_id: hash(1002).slice(2),
      event_index: 1, event_name: "FrozenAccountDrained", result: { account: affectedAddress, ...fields } };
    expect(parseTronEvent(usd1, event)?.amount_native).toBe(25 / 10 ** usd1.decimals);
  });

  it("keeps amount-less freezes unavailable and accepts only an emitted zero as zero", () => {
    const freeze = parseTronRpcEvent(usdt, normalize(captured[0].rpcLog), BASE_SEC, 1);
    expect(freeze).toMatchObject({ amount_native: null, amount_source: "unavailable", amount_status: "recoverable_pending" });
    const destroy = { ...normalize(captured[1].rpcLog), data: `0x${"0".repeat(64)}` };
    expect(parseTronRpcEvent(usdt, destroy, BASE_SEC, 1)).toMatchObject({
      amount_native: 0, amount_source: "event", amount_status: "resolved",
    });
  });

  it("refuses missing destroy amounts and invalid address padding", () => {
    expect(() => parseTronRpcEvent(usdt, { ...normalize(captured[1].rpcLog), data: "0x" }, BASE_SEC, 1))
      .toThrow("tron-rpc-invalid-event-amount");
    const invalid = { ...normalize(captured[0].rpcLog), topics: [usdt.events[0].topicHash, `0x${"f".repeat(64)}`] };
    expect(() => parseTronRpcEvent(usdt, invalid, BASE_SEC, 1)).toThrow("tron-rpc-invalid-event-address");
  });
});

describe("Tron freeze JSON-RPC scan", () => {
  it("catches up a missed six-hour run across two bounded log windows", async () => {
    const { scan, fetcher, runBudget } = harness({ head: 14_402, logs: [] });
    expect(await scan()).toMatchObject({ incomplete: false, apiError: false,
      scannedToTimestamp: blockTime(14_402) * 1000, failureSamples: [] });
    const filters = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter((request) => request.method === "eth_getLogs" && request.params[0].address)
      .map((request) => [Number(request.params[0].fromBlock), Number(request.params[0].toBlock)]);
    expect(filters).toEqual([[2, 10_001], [10_002, 14_402]]);
    expect(runBudget.subrequestBudget.count).toBe(fetcher.mock.calls.length);
  });

  it("stops at three windows with a proven prefix and leaves longer debt incomplete", async () => {
    const { scan, fetcher } = harness({ head: 40_000, logs: [], eventApiAllowed: true });
    expect(await scan()).toMatchObject({ incomplete: true, apiError: false,
      scannedToTimestamp: blockTime(30_001) * 1000, safeHead: blockTime(40_000) * 1000,
      failureSamples: ["tron-rpc-range-budget"] });
    const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.filter((request) => request.method === "eth_getLogs")).toHaveLength(3);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/v1/contracts/"))).toBe(false);
  });

  it.each([
    { clockOffsetMs: 600_001, reason: "tron-rpc-stale-solid-head" },
    { clockOffsetMs: -30_001, reason: "tron-rpc-future-solid-head" },
  ])("rejects $reason without letting the event API renew the frontier", async ({ clockOffsetMs, reason }) => {
    const { scan, fetcher } = harness({ nowMs: blockTime(308) * 1000 + clockOffsetMs,
      gridAllowed: true, eventApiAllowed: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await scan()).toMatchObject({ rows: [], incomplete: true, apiError: true,
        maxBlock: blockTime(2) * 1000, scannedToTimestamp: null, coveredTopicCount: 0,
        failureSamples: [reason] });
    }
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/v1/contracts/"))).toBe(false);
  });

  it("uses a fresh fallback solid head after rejecting a stale Dwellir head", async () => {
    const { scan } = harness({ gridAllowed: true, eventApiAllowed: true,
      respond: (url) => url.includes("dwellir.com/walletsolidity/getnowblock")
        ? Response.json({ blockID: hash(308).slice(2),
          block_header: { raw_data: { number: 308, timestamp: blockTime(8) * 1000 } } }) : undefined });
    expect(await scan()).toMatchObject({ incomplete: false, apiError: false,
      scannedToTimestamp: blockTime(8) * 1000, tronRpc: { source: "trongrid-jsonrpc",
        fallbackReason: "dwellir:tron-rpc-stale-solid-head", eventApiCalls: 0 } });
  });

  it("does not renew freshness when the admitted head expires during an otherwise complete scan", async () => {
    const nowMs = blockTime(308) * 1000 + 9 * 60_000;
    const { scan, fetcher } = harness({ nowMs, runtimeBudgetMs: 120_000, logs: [],
      gridAllowed: true, eventApiAllowed: true, respond: (_url, request) => {
        if (request.method === "eth_getLogs") vi.mocked(Date.now).mockReturnValue(nowMs + 60_001);
        return undefined;
      } });
    expect(await scan()).toMatchObject({ rows: [], incomplete: true, apiError: true,
      scannedToTimestamp: null, maxBlock: blockTime(2) * 1000,
      failureSamples: ["tron-rpc-stale-solid-head"], tronRpc: { eventApiCalls: 0 } });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/v1/contracts/"))).toBe(false);
  });

  it("uses the real transport to preserve inclusive timestamp cursors, all topics and local identities", async () => {
    const { scan, fetcher, runBudget } = harness();
    const result = await scan();
    expect(result).toMatchObject({ safeHead: blockTime(8) * 1000, scannedToTimestamp: blockTime(8) * 1000,
      incomplete: false, apiError: false, usedRpcLogs: true, topicCount: 3, coveredTopicCount: 3 });
    expect(result.rows.map((row) => row.id)).toEqual([`tron-${hash(1002).slice(2)}-1`, `tron-${hash(1004).slice(2)}-1`]);
    expect(result.rows.map((row) => [row.transaction_index, row.timestamp, row.amount_native])).toEqual([
      [1, blockTime(2), null], [1, blockTime(4), 25],
    ]);
    expect(result.tronRpc).toMatchObject({ source: "dwellir-jsonrpc", trongridRpcCalls: 0, eventApiCalls: 0,
      orderRepairSkippedRows: 2, orderRepairSkipReason: "rpc-transaction-index-observed",
      amountRepairSkippedRows: 1, amountRepairSkipReason: "rpc-event-amount-observed" });
    const filters = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter((request) => request.method === "eth_getLogs" && request.params[0].address);
    expect(filters).toHaveLength(1);
    expect(filters[0].params[0]).toEqual({ fromBlock: "0x2", toBlock: "0x8",
      address: captured[0].rpcLog.address, topics: [usdt.events.map((event) => event.topicHash)] });
    expect(result.providerCalls).toBe(fetcher.mock.calls.length);
    expect(runBudget.subrequestBudget.count).toBe(fetcher.mock.calls.length);
  });

  it("uses TronGrid JSON-RPC after Dwellir transport failure without changing row identities", async () => {
    const { scan, fetcher } = harness({ gridAllowed: true,
      respond: (url) => url.includes("dwellir.com") ? new Response("unavailable", { status: 503 }) : undefined });
    const result = await scan();
    expect(result).toMatchObject({ incomplete: false, apiError: false, usedRpcLogs: true });
    expect(result.rows).toHaveLength(2);
    expect(result.tronRpc).toMatchObject({ source: "trongrid-jsonrpc", dwellirCalls: 1, eventApiCalls: 0 });
    for (const [url, init] of fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (String(url).includes("trongrid.io")) {
        expect(headers.get("TRON-PRO-API-KEY")).toBe("test-trongrid-key");
        expect(headers.has("X-Api-Key")).toBe(false);
      }
    }
  });

  it("falls back to event-API pages clipped to the validated safe timestamp", async () => {
    const event = { block_number: 2, block_timestamp: blockTime(2) * 1000,
      transaction_id: hash(1002).slice(2), event_index: 1, event_name: "AddedBlackList", result: { _user: affectedAddress } };
    const { scan, fetcher } = harness({ head: 8, nowMs: blockTime(30) * 1000 + TRON_INDEXING_SAFETY_MS,
      eventApiAllowed: true, eventApiData: [event], respond: (_url, request) => request.method === "eth_getLogs"
        ? Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "unavailable" } }) : undefined });
    const result = await scan();
    expect(result).toMatchObject({ incomplete: false, apiError: false, scannedToTimestamp: blockTime(30) * 1000,
      safeHead: blockTime(30) * 1000, tronRpc: { source: "trongrid-events", eventApiCalls: 3,
        orderRepairSkippedRows: 0, orderRepairSkipReason: null, amountRepairSkippedRows: 0 } });
    expect(result.rows).toEqual([parseTronEvent(usdt, event)]);
    const pages = fetcher.mock.calls.filter(([url]) => String(url).includes("/v1/contracts/"));
    expect(pages).toHaveLength(3);
    for (const [url] of pages) {
      expect(new URL(String(url)).searchParams.get("min_block_timestamp")).toBe(String(blockTime(2) * 1000));
      expect(new URL(String(url)).searchParams.get("max_block_timestamp")).toBe(String(blockTime(30) * 1000));
      expect(new URL(String(url)).searchParams.get("only_confirmed")).toBe("true");
    }
  });

  it("publishes only the proven prefix after range splitting fails at an indivisible block", async () => {
    const { scan } = harness({ logs: [rawLog(2)], respond: (_url, request) => {
      if (request.method !== "eth_getLogs") return undefined;
      const filter = request.params[0] as Filter;
      if (filter.address && Number(filter.toBlock) >= 6) return Response.json({ jsonrpc: "2.0", id: request.id,
        error: { code: -32005, message: "range too large" } });
      return undefined;
    } });
    const result = await scan();
    expect(result).toMatchObject({ incomplete: true, apiError: true, safeHead: blockTime(8) * 1000,
      scannedToTimestamp: blockTime(5) * 1000, topicCount: 3, coveredTopicCount: 3,
      maxSplitDepth: 3, failureSamples: ["tron-rpc-provider-error"] });
    expect(result.rows.map((row) => row.block_number)).toEqual([2]);
  });

  it.each(["context", "amount"])("stops before a block with failed %s evidence", async (failure) => {
    const logs = [rawLog(2), { ...rawLog(4, 2), ...(failure === "amount" ? { data: "0x" } : {}) }];
    const { scan } = harness({ logs, respond: (_url, request) => {
      if (request.method !== "eth_getLogs" || failure !== "context") return undefined;
      const filter = request.params[0] as Filter;
      return !filter.address && Number(filter.fromBlock) === 4
        ? Response.json({ jsonrpc: "2.0", id: request.id, result: [] }) : undefined;
    } });
    const result = await scan();
    expect(result).toMatchObject({ incomplete: true, apiError: true, scannedToTimestamp: blockTime(3) * 1000,
      safeHead: blockTime(8) * 1000, coveredTopicCount: 3 });
    expect(result.rows.map((row) => row.block_number)).toEqual([2]);
    expect(result.failureSamples).toEqual([failure === "context" ? "tron-rpc-block-context-mismatch" : "tron-rpc-invalid-event-amount"]);
  });

  it.each([{ limit: 0 }, { expired: true }])("does not fetch or advance when the shared budget is closed: %j", async (options) => {
    const { scan, fetcher } = harness({ ...options, eventApiAllowed: true });
    expect(await scan()).toMatchObject({ rows: [], incomplete: true, scannedToTimestamp: null,
      maxBlock: blockTime(2) * 1000, failureSamples: ["tron-rpc-budget-exhausted"] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains a TronGrid failure when the following boundary-header read exhausts the budget", async () => {
    const { scan, fetcher, reader } = harness({ logs: [], gridAllowed: true, limit: 13,
      respond: (_url, request) => {
        if (request.method !== "eth_getLogs") return undefined;
        const filter = request.params[0] as Filter;
        if (!filter.address) return undefined;
        if (Number(filter.fromBlock) === 4) return new Response("unavailable", { status: 503 });
        if (Number(filter.toBlock) > 3) return Response.json({ jsonrpc: "2.0", id: request.id,
          error: { code: -32005, message: "range too large" } });
        return undefined;
      } });
    const result = await scan();
    expect(result).toMatchObject({ incomplete: true, apiError: false, scannedToTimestamp: null,
      failureSamples: ["tron-rpc-budget-exhausted"], tronRpc: {
        fallbackReason: "tron-rpc-budget-exhausted", trongridFailureReason: "trongrid:tron-rpc-transport-error",
      } });
    expect(reader.failures).toContain("trongrid:tron-rpc-transport-error");
    expect(fetcher).toHaveBeenCalledTimes(13);
  });

  it("uses the existing event-API bootstrap for a zero timestamp cursor", async () => {
    const { scan, fetcher } = harness({ eventApiAllowed: true });
    expect(await scan(0)).toMatchObject({ incomplete: false, tronRpc: {
      source: "trongrid-events", dwellirCalls: 0, trongridRpcCalls: 0, eventApiCalls: 3,
      fallbackReason: "tron-rpc-bootstrap-event-api",
    } });
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("/v1/contracts/"))).toBe(true);
  });

  it("does not fall back or advance an already-ahead timestamp cursor", async () => {
    const { scan, fetcher } = harness({ eventApiAllowed: true });
    const cursor = blockTime(9) * 1000;
    expect(await scan(cursor)).toMatchObject({ incomplete: true, scannedToTimestamp: null, maxBlock: cursor,
      safeHead: blockTime(8) * 1000, failureSamples: ["tron-rpc-cursor-ahead"] });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/v1/contracts/"))).toBe(false);
  });

  it("proves quiet all-topic coverage without inventing rows or repair skips", async () => {
    const { scan } = harness({ logs: [] });
    expect(await scan()).toMatchObject({ rows: [], incomplete: false, apiError: false,
      scannedToTimestamp: blockTime(8) * 1000, topicCount: 3, coveredTopicCount: 3,
      tronRpc: { orderRepairSkippedRows: 0, orderRepairSkipReason: null,
        amountRepairSkippedRows: 0, amountRepairSkipReason: null } });
  });
});
