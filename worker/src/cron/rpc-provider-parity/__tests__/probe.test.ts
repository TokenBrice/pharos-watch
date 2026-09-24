import { describe, expect, it } from "vitest";
import { buildChainRpcs, type ChainRpcConfig } from "../../../lib/chain-registry";
import { USER_AGENT } from "../../../lib/constants";
import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import {
  classifyRpcParityHttpFailure,
  classifyRpcParityJsonRpcError,
  classifyRpcParityTransportError,
  normalizeRpcQuantity,
  probeRpcProviderParityRun,
  rpcParityCommonBlockMargin,
  RPC_PARITY_LOG_WINDOW_BLOCKS,
  RPC_PARITY_PRUNED_LOG_DEPTH_BLOCKS,
} from "../probe";
import { RPC_PARITY_TARGETS, type RpcParityTarget } from "../../../lib/rpc-provider-parity/targets";

const API_KEY = "dwellir-parity-test-key";
const START_MS = 1_789_000_000_000;

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  method: string;
  params: unknown[];
}

type FakeReply =
  | { kind: "json"; body: unknown; status?: number }
  | { kind: "raw"; body: string; status?: number }
  | { kind: "throw"; error: unknown };

function rpcResult(result: unknown): FakeReply {
  return { kind: "json", body: { jsonrpc: "2.0", id: 1, result } };
}

/** Transport double that records every call and measures how many were open at once. */
function createFakeTransport(reply: (call: RecordedCall) => FakeReply) {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const fetchText = (async (url: string, init?: RequestInit) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: unknown[] };
      const call: RecordedCall = { url, headers, method: payload.method ?? "", params: payload.params ?? [] };
      calls.push(call);
      const outcome = reply(call);
      if (outcome.kind === "throw") throw outcome.error;
      const raw = outcome.kind === "json" ? JSON.stringify(outcome.body) : outcome.body;
      return { response: new Response(raw, { status: outcome.status ?? 200 }), body: raw };
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetchTextWithRetry;
  return { fetchText, calls, peakInFlight: () => peakInFlight };
}

function target(chainId: string): RpcParityTarget {
  const found = RPC_PARITY_TARGETS.find((candidate) => candidate.chainId === chainId);
  if (!found) throw new Error(`missing parity target for ${chainId}`);
  return found;
}

function isDwellir(url: string): boolean {
  return url.includes(".n.dwellir.com");
}

function runProbe(options: {
  targets: readonly RpcParityTarget[];
  fetchText: typeof fetchTextWithRetry;
  chainRpcs?: Map<string, ChainRpcConfig>;
  nowMs?: () => number;
  deadlineMs?: number;
  signal?: AbortSignal;
  credits?: { count: number };
}) {
  const credits = options.credits ?? { count: 0 };
  return probeRpcProviderParityRun({
    targets: options.targets,
    chainRpcs: options.chainRpcs ?? buildChainRpcs(),
    dwellirApiKey: API_KEY,
    signal: options.signal ?? new AbortController().signal,
    deadlineMs: options.deadlineMs ?? START_MS + 60_000,
    deps: {
      fetchText: options.fetchText,
      nowMs: options.nowMs ?? (() => START_MS),
      recordCredits: (count) => {
        credits.count += count;
      },
    },
  });
}

describe("rpc parity probe", () => {
  it("probes serially, one request in flight, and keeps the key out of every URL", async () => {
    const credits = { count: 0 };
    const transport = createFakeTransport((call) => {
      const dwellir = isDwellir(call.url);
      if (call.method === "eth_blockNumber") return rpcResult(dwellir ? "0x64" : "0x66");
      if (call.method === "eth_call") return rpcResult("0x0de0b6b3a7640000");
      return rpcResult(
        dwellir
          ? [{ transactionHash: "0xAA", logIndex: "0x1" }, { transactionHash: "0xaa", logIndex: "0x0" }]
          : [{ transactionHash: "0xaa", logIndex: "0x0" }, { transactionHash: "0xAA", logIndex: "0x1" }],
      );
    });

    const result = await runProbe({ targets: [target("base")], fetchText: transport.fetchText, credits });

    expect(result).toMatchObject({ attempted: 1, headOk: 1, deadlineHit: false, aborted: false, skipped: [] });
    expect(transport.peakInFlight()).toBe(1);
    expect(transport.calls).toHaveLength(6);
    expect(credits.count).toBe(3); // one credit per Dwellir request, none for the comparator

    const [sample] = result.samples;
    expect(sample).toMatchObject({
      chainId: "base",
      comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
      dwellirHost: "api-base-mainnet-archive.n.dwellir.com",
      headOk: true,
      comparatorHeadOk: true,
      comparatorHead: 102,
      dwellirHead: 100,
      lagBlocks: 2,
      commonBlock: 98,
      stateChecked: true,
      stateMatched: true,
      logChecked: true,
      logMatched: true,
      errorClass: null,
    });

    for (const call of transport.calls) {
      expect(call.url).not.toContain(API_KEY);
    }
    const dwellirCalls = transport.calls.filter((call) => isDwellir(call.url));
    const comparatorCalls = transport.calls.filter((call) => !isDwellir(call.url));
    expect(dwellirCalls).toHaveLength(3);
    for (const call of dwellirCalls) {
      expect(call.headers["x-api-key"]).toBe(API_KEY);
    }
    for (const call of comparatorCalls) {
      expect(call.headers["x-api-key"]).toBeUndefined();
    }

    // State and log parity read the same historical block on both operators.
    const ethCall = transport.calls.find((call) => call.method === "eth_call");
    expect(ethCall?.params).toEqual([
      { to: target("base").contract, data: "0x18160ddd" },
      "0x62",
    ]);
    const logsCalls = transport.calls.filter((call) => call.method === "eth_getLogs");
    expect(logsCalls).toHaveLength(2);
    const baseWindowBlocks = target("base").logWindowBlocks ?? RPC_PARITY_LOG_WINDOW_BLOCKS;
    for (const call of logsCalls) {
      expect(call.params).toEqual([
        {
          address: target("base").contract,
          fromBlock: `0x${(98 - (baseWindowBlocks - 1)).toString(16)}`,
          toBlock: "0x62",
        },
      ]);
    }
  });

  it("narrows the log window on high-volume chains and reports an all-clear sample", async () => {
    const transport = createFakeTransport((call) => {
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({
      // ethereum's USDC log volume overflows the lane's response bound on a
      // ten-block window, so the target narrows it; arbitrum keeps the default.
      targets: [target("ethereum"), target("arbitrum")],
      fetchText: transport.fetchText,
    });

    const [ethereum, arbitrum] = result.samples;
    expect(ethereum.logChecked).toBe(true);
    expect(ethereum.logMatched).toBe(true);
    expect(ethereum.failedSteps).toEqual({
      dwellir: { head: false, state: false, logs: false },
      comparator: { head: false, state: false, logs: false },
    });
    expect(ethereum.comparatorErrorClass).toBeNull();
    expect(ethereum.comparatorHttpStatus).toBeNull();

    const logsWindowFor = (chainId: string) => transport.calls.filter((call) => (
      call.method === "eth_getLogs"
      && JSON.stringify(call.params[0]).includes(target(chainId).contract)
    ));
    // Both operators read the same narrowed window on ethereum.
    const ethereumWindow = logsWindowFor("ethereum");
    expect(ethereumWindow).toHaveLength(2);
    for (const call of ethereumWindow) {
      expect(call.params).toEqual([
        {
          address: target("ethereum").contract,
          fromBlock: `0x${(98 - (target("ethereum").logWindowBlocks ?? 10) + 1).toString(16)}`,
          toBlock: "0x62",
        },
      ]);
    }

    // A chain with no override keeps the ten-block window on both operators.
    const arbitrumWindow = logsWindowFor("arbitrum");
    expect(arbitrumWindow).toHaveLength(2);
    for (const call of arbitrumWindow) {
      expect(call.params).toEqual([
        {
          address: target("arbitrum").contract,
          fromBlock: `0x${(84 - 9).toString(16)}`,
          toBlock: "0x54",
        },
      ]);
    }
    expect(arbitrum.logChecked).toBe(true);
  });

  it("records which step and status failed on the comparator side", async () => {
    const transport = createFakeTransport((call) => {
      if (call.url.startsWith("https://base-mainnet.g.alchemy.com")) {
        return { kind: "raw", body: "error code: 1010", status: 403 };
      }
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({
      targets: [target("base")],
      fetchText: transport.fetchText,
      chainRpcs: buildChainRpcs("parity-test-alchemy-key"),
    });

    const [sample] = result.samples;
    // The baseline is unreadable, so no lag, state, or log claim is made.
    expect(sample.comparatorHeadOk).toBe(false);
    expect(sample.headOk).toBe(true);
    expect(sample.lagBlocks).toBeNull();
    expect(sample.stateChecked).toBe(false);
    expect(sample.logChecked).toBe(false);
    expect(sample.failedSteps).toEqual({
      dwellir: { head: false, state: false, logs: false },
      comparator: { head: true, state: false, logs: false },
    });
    expect(sample.comparatorErrorClass).toBe("capability");
    expect(sample.comparatorHttpStatus).toBe(403);
    // The Dwellir side carries no fault of its own.
    expect(sample.errorClass).toBeNull();
    expect(sample.failedSteps.dwellir.head).toBe(false);
  });

  it("attributes a mid-step comparator failure without blaming the Dwellir side", async () => {
    let comparatorStateCalls = 0;
    const transport = createFakeTransport((call) => {
      const comparator = !isDwellir(call.url);
      if (comparator && call.method === "eth_call") {
        comparatorStateCalls += 1;
        return { kind: "raw", body: "error code: 1010", status: 403 };
      }
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({ targets: [target("megaeth")], fetchText: transport.fetchText });

    expect(comparatorStateCalls).toBe(1);
    const [sample] = result.samples;
    expect(sample.headOk).toBe(true);
    expect(sample.comparatorHeadOk).toBe(true);
    expect(sample.stateChecked).toBe(false);
    expect(sample.failedSteps.comparator.state).toBe(true);
    expect(sample.failedSteps.dwellir.state).toBe(false);
    expect(sample.comparatorErrorClass).toBe("capability");
    expect(sample.comparatorHttpStatus).toBe(403);
    // Only the state step is written off: the window still compares logs, so
    // the sample keeps the evidence it could gather.
    expect(sample.logChecked).toBe(true);
  });

  it("treats an unavailable operator read as unchecked rather than as a mismatch (R1)", async () => {
    const transport = createFakeTransport((call) => {
      // base: Dwellir's log read never answers; megaeth: its state read does not.
      if (isDwellir(call.url) && call.url.includes("api-base-mainnet") && call.method === "eth_getLogs") {
        return { kind: "throw", error: new DOMException("fetch timed out after 8000ms", "TimeoutError") };
      }
      if (isDwellir(call.url) && call.url.includes("api-megaeth-mainnet") && call.method === "eth_call") {
        return { kind: "throw", error: new DOMException("fetch timed out after 8000ms", "TimeoutError") };
      }
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([{ transactionHash: "0xaa", logIndex: "0x0" }]);
    });

    const result = await runProbe({ targets: [target("base"), target("megaeth")], fetchText: transport.fetchText });
    const [base, megaeth] = result.samples;

    // A read that produced no value is unavailable: no check, and no mismatch claim.
    expect(base.headOk).toBe(true);
    expect(base.stateChecked).toBe(true);
    expect(base.stateMatched).toBe(true);
    expect(base.logChecked).toBe(false);
    expect(base.logMatched).toBe(false);
    expect(base.failedSteps.dwellir.logs).toBe(true);
    expect(base.failedSteps.comparator.logs).toBe(false);
    expect(base.errorClass).toBe("timeout");

    // The same rule for the state step: the log window is still compared.
    expect(megaeth.stateChecked).toBe(false);
    expect(megaeth.stateMatched).toBe(false);
    expect(megaeth.failedSteps.dwellir.state).toBe(true);
    expect(megaeth.logChecked).toBe(true);
    expect(megaeth.logMatched).toBe(true);
  });

  it("flags a Dwellir head failure as a Dwellir step failure", async () => {
    const transport = createFakeTransport((call) => {
      if (isDwellir(call.url) && call.method === "eth_blockNumber") {
        return { kind: "raw", body: "upstream unavailable", status: 503 };
      }
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({ targets: [target("base")], fetchText: transport.fetchText });
    const [sample] = result.samples;
    expect(sample.failedSteps.dwellir.head).toBe(true);
    expect(sample.failedSteps.comparator.head).toBe(false);
    expect(sample.errorClass).toBe("server-error");
    expect(sample.comparatorErrorClass).toBeNull();
    expect(sample.comparatorHttpStatus).toBeNull();
  });

  it("replays the comparator operator's auth, keeps pins keyless, and identifies every request", async () => {
    const alchemyKey = "parity-test-alchemy-key";
    const transport = createFakeTransport((call) => {
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({
      // base resolves to the Alchemy registry comparator (its URL carries no
      // key), megaeth to a reviewed keyless public pin.
      targets: [target("base"), target("megaeth")],
      fetchText: transport.fetchText,
      chainRpcs: buildChainRpcs(alchemyKey),
    });

    expect(result.samples.map((sample) => sample.chainId)).toEqual(["base", "megaeth"]);
    expect(result.samples[0].comparator).toEqual({
      operator: "alchemy",
      host: "base-mainnet.g.alchemy.com",
      source: "registry",
    });

    const alchemyCalls = transport.calls.filter((call) => call.url.startsWith("https://base-mainnet.g.alchemy.com/v2/"));
    expect(alchemyCalls).toHaveLength(3);
    for (const call of alchemyCalls) {
      expect(call.headers.authorization).toBe(`Bearer ${alchemyKey}`);
      expect(call.headers["x-api-key"]).toBeUndefined();
    }

    const pinCalls = transport.calls.filter((call) => call.url === "https://mainnet.megaeth.com/rpc");
    expect(pinCalls).toHaveLength(3);
    for (const call of pinCalls) {
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers["x-api-key"]).toBeUndefined();
    }

    const dwellirCalls = transport.calls.filter((call) => isDwellir(call.url));
    expect(dwellirCalls).toHaveLength(6);
    for (const call of dwellirCalls) {
      expect(call.headers["x-api-key"]).toBe(API_KEY);
      expect(call.headers.authorization).toBeUndefined();
    }
    for (const call of transport.calls) {
      expect(call.headers["user-agent"]).toBe(USER_AGENT);
      expect(call.url).not.toContain(alchemyKey);
    }
  });

  it("records a mismatch without blaming the provider for returning an answer", async () => {
    const transport = createFakeTransport((call) => {
      const dwellir = isDwellir(call.url);
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult(dwellir ? "0x1" : "0x2");
      return rpcResult(dwellir ? [{ transactionHash: "0xaa", logIndex: "0x0" }] : [
        { transactionHash: "0xaa", logIndex: "0x0" },
        { transactionHash: "0xbb", logIndex: "0x1" },
      ]);
    });

    const result = await runProbe({ targets: [target("base")], fetchText: transport.fetchText });
    const [sample] = result.samples;
    expect(sample.stateChecked).toBe(true);
    expect(sample.stateMatched).toBe(false);
    expect(sample.logChecked).toBe(true);
    expect(sample.logMatched).toBe(false);
    expect(sample.errorClass).toBeNull();
  });

  it("classifies HTTP and JSON-RPC failures, and a plan refusal does not stop the run", async () => {
    const transport = createFakeTransport((call) => {
      if (!isDwellir(call.url)) {
        if (call.method === "eth_blockNumber") return rpcResult("0x64");
        if (call.method === "eth_call") return rpcResult("0x1");
        return rpcResult([]);
      }
      if (call.url.includes("api-megaeth-mainnet")) {
        return { kind: "raw", body: "<html>This method does not support this operation</html>", status: 403 };
      }
      if (call.method === "eth_blockNumber") return rpcResult("0x64");
      if (call.method === "eth_call") return rpcResult("0x1");
      return rpcResult([]);
    });

    const result = await runProbe({ targets: [target("megaeth"), target("base")], fetchText: transport.fetchText });
    expect(result.attempted).toBe(2);
    expect(result.headOk).toBe(1);
    expect(result.skipped).toEqual([]);
    const [refused, healthy] = result.samples;
    expect(refused.chainId).toBe("megaeth");
    expect(refused.errorClass).toBe("capability");
    expect(refused.headOk).toBe(false);
    expect(refused.stateChecked).toBe(false);
    expect(refused.logChecked).toBe(false);
    expect(healthy.headOk).toBe(true);
    expect(healthy.errorClass).toBeNull();
  });

  it("records the silent pruned-log trap for logsHistory none chains", async () => {
    const head = 100_000_000;
    const transport = createFakeTransport((call) => {
      const dwellir = isDwellir(call.url);
      if (call.method === "eth_blockNumber") return rpcResult(`0x${head.toString(16)}`);
      if (call.method === "eth_call") return rpcResult("0x1");
      if (dwellir) return rpcResult([]);
      return rpcResult([
        { transactionHash: "0xaa", logIndex: "0x0" },
        { transactionHash: "0xbb", logIndex: "0x1" },
      ]);
    });

    const result = await runProbe({ targets: [target("zksync")], fetchText: transport.fetchText });
    const [sample] = result.samples;
    expect(sample.prunedLogChecked).toBe(true);
    expect(sample.prunedLogTrap).toBe(true);
    // The chain's log history is declared absent, so it carries no log-parity claim.
    expect(sample.logChecked).toBe(false);
    expect(sample.logMatched).toBe(false);

    const toBlock = head - rpcParityCommonBlockMargin(target("zksync").blockTimeSec) - RPC_PARITY_PRUNED_LOG_DEPTH_BLOCKS;
    const deepWindow = transport.calls.filter((call) => call.method === "eth_getLogs");
    expect(deepWindow).toHaveLength(2);
    for (const call of deepWindow) {
      expect(call.params).toEqual([
        {
          address: target("zksync").contract,
          fromBlock: `0x${(toBlock - (RPC_PARITY_LOG_WINDOW_BLOCKS - 1)).toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
        },
      ]);
    }
  });

  it("stops starting chains once the run deadline passes", async () => {
    let clock = START_MS;
    const transport = createFakeTransport(() => {
      clock += 20_000;
      return rpcResult("0x64");
    });

    const result = await runProbe({
      targets: [target("base"), target("megaeth"), target("zksync")],
      fetchText: transport.fetchText,
      nowMs: () => clock,
      deadlineMs: START_MS + 30_000,
    });

    expect(result.deadlineHit).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.samples).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(result.skipped).toEqual([
      { chainId: "base", reason: "deadline" },
      { chainId: "megaeth", reason: "deadline" },
      { chainId: "zksync", reason: "deadline" },
    ]);
    expect(transport.calls.length).toBeLessThanOrEqual(2);
  });

  it("abandons the run when the job signal fires", async () => {
    const controller = new AbortController();
    const transport = createFakeTransport(() => {
      controller.abort();
      return rpcResult("0x64");
    });

    const result = await runProbe({
      targets: [target("base"), target("megaeth")],
      fetchText: transport.fetchText,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.samples).toEqual([]);
    expect(result.skipped).toEqual([{ chainId: "base", reason: "aborted" }]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.peakInFlight()).toBe(1);
  });
});

describe("rpc parity failure classification", () => {
  it("maps HTTP statuses and capability bodies", () => {
    expect(classifyRpcParityHttpFailure(429, "slow down")).toBe("rate-limited");
    expect(classifyRpcParityHttpFailure(408, "")).toBe("timeout");
    expect(classifyRpcParityHttpFailure(403, "")).toBe("capability");
    expect(classifyRpcParityHttpFailure(403, "This method does not support this operation")).toBe("capability");
    expect(classifyRpcParityHttpFailure(404, "not found")).toBe("capability");
    expect(classifyRpcParityHttpFailure(503, "upstream unavailable")).toBe("server-error");
    expect(classifyRpcParityHttpFailure(400, "bad request")).toBe("invalid-response");
  });

  it("maps JSON-RPC error codes and messages", () => {
    expect(classifyRpcParityJsonRpcError(-32005, "block range too large")).toBe("range-cap");
    expect(classifyRpcParityJsonRpcError(null, "requested block limit exceeded")).toBe("range-cap");
    expect(classifyRpcParityJsonRpcError(null, "too many logs in the requested range")).toBe("result-cap");
    expect(classifyRpcParityJsonRpcError(null, "max results exceeded")).toBe("result-cap");
    expect(classifyRpcParityJsonRpcError(null, "query returned more than 10000 results")).toBe("result-cap");
    expect(classifyRpcParityJsonRpcError(null, "method does not support eth_getLogs")).toBe("capability");
    expect(classifyRpcParityJsonRpcError(-32602, "invalid params")).toBe("rpc-error");
  });

  it("maps transport failures", () => {
    expect(classifyRpcParityTransportError(new DOMException("timed out", "TimeoutError"))).toBe("timeout");
    expect(classifyRpcParityTransportError(new DOMException("aborted", "AbortError"))).toBe("timeout");
    expect(classifyRpcParityTransportError(new Error("socket hang up"))).toBe("network");
    expect(classifyRpcParityTransportError({ maxBytes: 1024, observedBytes: 4096 })).toBe("invalid-response");
  });

  it("normalizes quantities for exact comparison", () => {
    expect(normalizeRpcQuantity("0x0abc")).toBe("2748");
    expect(normalizeRpcQuantity("0xAbC")).toBe("2748");
    expect(normalizeRpcQuantity("0x")).toBeNull();
    expect(normalizeRpcQuantity("2748")).toBeNull();
    expect(normalizeRpcQuantity(null)).toBeNull();
  });
});
