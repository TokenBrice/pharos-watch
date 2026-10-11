import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { main } from "../dwellir-rpc.mjs";

vi.mock("tsx/esm/api", () => ({ register: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => "") }));

const KEY = "test-header-only-key";
const HASH = `0x${"a".repeat(64)}`;
const originalExitCode = process.exitCode;
let stdout: string[];
let fetchMock: Mock<(url: string | URL, init: RequestInit) => Promise<Response>>;

function rpcResponse(id: number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function header(number: string) {
  return { number, hash: HASH, timestamp: "0x6553f100" };
}

async function invoke(extra: string[], chain = "ethereum", method = "eth_call", params = '[{"to":"0x1111111111111111111111111111111111111111","data":"0x18160ddd"}]') {
  await main(["--chain", chain, "--method", method, "--params", params, ...extra]);
  return JSON.parse(stdout.join(""));
}

beforeEach(() => {
  stdout = [];
  process.exitCode = undefined;
  vi.stubEnv("DWELLIR_API_KEY", KEY);
  vi.stubEnv("ALCHEMY_API_KEY", "alchemy-test-key");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  fetchMock = vi.fn(async (_url: string | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return rpcResponse(body.id, body.method === "eth_getBlockByNumber" || body.method === "eth_getBlockByHash"
      ? header(body.method === "eth_getBlockByHash" ? "0x3e8" : body.params[0])
      : "0x1");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pinned supplemental research RPC", () => {
  it.each([
    { name: "missing", extra: [] },
    { name: "latest", extra: ["--block", "latest"] },
    { name: "pending", extra: ["--block", "pending"] },
  ])("rejects an absent or symbolic state pin before fetching: $name", async ({ extra }) => {
    const record = await invoke(extra);
    expect(record).toMatchObject({ state: "error", reason: "invalid-arguments", result: null, block: null });
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports output-write failure in stdout and exit status without publishing the result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dwellir-rpc-output-"));
    try {
      const record = await invoke(["--block", "1000", "--out", directory]);
      expect(record).toMatchObject({ state: "error", reason: "output-write-failed", result: null,
        error: { message: "Cannot write --out provenance file" } });
      expect(process.exitCode).toBe(1);
      expect(stdout.join("")).not.toContain(KEY);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the canonical key and .env.example when credentials are missing", async () => {
    vi.stubEnv("DWELLIR_API_KEY", "");
    const record = await invoke(["--block", "1000"]);
    expect(record).toMatchObject({ state: "error", reason: "missing-api-key", result: null });
    expect(record.error.message).toContain("DWELLIR_API_KEY");
    expect(record.error.message).toContain(".env.example");
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses latest in state parameters rather than silently replacing it", async () => {
    const record = await invoke(["--block", "1000"], "ethereum", "eth_call", '[{"to":"0x1111111111111111111111111111111111111111"},"latest"]');
    expect(record).toMatchObject({ state: "error", reason: "invalid-arguments", result: null });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).method)).not.toContain("eth_call");
  });

  it.each(["eth_call", "batch"])("preserves a pinned %s state override and labels simulation evidence", async (method) => {
    const params = [{ to: "0x1111111111111111111111111111111111111111" }, "1000",
      { "0x1111111111111111111111111111111111111111": { balance: "0x25" } }];
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (Array.isArray(body)) {
        expect(body[0].params).toEqual([params[0], "0x3e8", params[2]]);
        return new Response(JSON.stringify(body.map((item) => ({ jsonrpc: "2.0", id: item.id, result: "0x25" }))));
      }
      if (body.method === "eth_call") expect(body.params).toEqual([params[0], "0x3e8", params[2]]);
      return rpcResponse(body.id, body.method === "eth_call" ? "0x25" : header(body.params[0]));
    });
    const record = await invoke(["--block", "1000"], "ethereum", method,
      JSON.stringify(method === "batch" ? [{ method: "eth_call", params }] : params));
    expect(record).toMatchObject({ state: "ok", simulation: true, block: { number: "1000" } });
    if (method === "batch") expect(record.result[0]).toMatchObject({ result: "0x25", simulation: true });
    else expect(record.result).toBe("0x25");
  });

  it.each([
    [{}, "latest", {}],
    [{}, "1001", {}],
    [{}, "1000", []],
    [{}, "1000", null],
  ])("rejects unpinned or malformed overrides without an execution request: %j", async (...params) => {
    const record = await invoke(["--block", "1000"], "ethereum", "eth_call", JSON.stringify(params));
    expect(record).toMatchObject({ state: "error", reason: "invalid-arguments", result: null });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).method)).not.toContain("eth_call");
  });

  it("withholds simulation results when a provider rejects state overrides", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return body.method === "eth_call"
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "state override unsupported" } }))
        : rpcResponse(body.id, header(body.params[0]));
    });
    const record = await invoke(["--block", "1000"], "ethereum", "eth_call", '[{},"1000",{}]');
    expect(record).toMatchObject({ state: "error", reason: "rpc-error", result: null, simulation: true });
  });

  it("captures block provenance and scopes the secret to the header, including provider echoes", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "eth_call" ? { echo: KEY } : header(body.params[0]));
    });
    const record = await invoke(["--block", "1000"]);
    expect(record).toMatchObject({
      chain: "ethereum", state: "ok", reason: null,
      endpoint: "https://api-ethereum-mainnet-erigon.n.dwellir.com",
      block: { number: "1000", hash: HASH, timestamp: "2023-11-14T22:13:20.000Z" },
      result: { echo: "[REDACTED]" },
    });
    expect(record.params[1]).toBe("0x3e8");
    expect(record.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stdout.join("")).not.toContain(KEY);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(KEY);
      expect(init.headers).toMatchObject({ "X-Api-Key": KEY });
      expect(init.redirect).toBe("error");
      expect(String(init.body)).not.toContain(KEY);
    }
  });

  it("resolves a hash pin to numeric state params with the recorded header hash", async () => {
    const record = await invoke(["--block", HASH]);
    expect(record).toMatchObject({ state: "ok", requestedBlock: HASH, block: { number: "1000", hash: HASH } });
    expect(record.params[1]).toBe("0x3e8");
  });

  it("splits 501 inclusive log blocks into 500 + 1 in order and never treats empty as absence", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "eth_getLogs" ? [] : header(body.params[0]));
    });
    const record = await invoke(["--block", "1500"], "ethereum", "eth_getLogs", '[{"fromBlock":"0x3e8","toBlock":"0x5dc"}]');
    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body))).filter((body) => body.method === "eth_getLogs");
    expect(calls.map((body) => body.params[0])).toEqual([
      { fromBlock: "0x3e8", toBlock: "0x5db" }, { fromBlock: "0x5dc", toBlock: "0x5dc" },
    ]);
    expect(record).toMatchObject({ state: "empty", reason: "empty-result-not-proof-of-absence", result: [], range: { fromBlock: "1000", toBlock: "1500" } });
    expect(record.chunks).toHaveLength(2);
  });

  it("withholds completed chunks when any later log chunk fails", async () => {
    let logCalls = 0;
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method !== "eth_getLogs") return rpcResponse(body.id, header(body.params[0]));
      logCalls++;
      if (logCalls === 2) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32005, message: KEY } }));
      return rpcResponse(body.id, [{ blockNumber: "0x3e8", blockHash: HASH, logIndex: "0x0" }]);
    });
    const record = await invoke(["--block", "1500"], "ethereum", "eth_getLogs", '[{"fromBlock":"1000","toBlock":"1500"}]');
    expect(record).toMatchObject({ state: "error", reason: "rpc-error", result: null, error: { rpcCode: -32005 } });
    expect(record.chunks).toHaveLength(1);
    expect(stdout.join("")).not.toContain(KEY);
    expect(process.exitCode).toBe(1);
  });

  it("splits result-capped log chunks at the provider's suggested bound and preserves order", async () => {
    const ranges: string[][] = [];
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method !== "eth_getLogs") return rpcResponse(body.id, header(body.params[0]));
      const { fromBlock, toBlock } = body.params[0];
      const start = BigInt(fromBlock);
      const end = BigInt(toBlock);
      ranges.push([start.toString(), end.toString()]);
      if (end - start > 1n) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: {
          code: -32602, message: `query exceeds max results 10000, retry with the range ${start}-${start}`,
        } }));
      }
      return rpcResponse(body.id, [{ blockNumber: fromBlock, blockHash: HASH }]);
    });
    const record = await invoke(["--block", "1003"], "ethereum", "eth_getLogs", '[{"fromBlock":"1000","toBlock":"1003"}]');
    expect(ranges).toEqual([["1000", "1003"], ["1000", "1000"], ["1001", "1003"], ["1001", "1001"], ["1002", "1003"]]);
    expect(record).toMatchObject({ state: "ok", reason: null });
    expect(record.result.map((log: { blockNumber: string }) => log.blockNumber)).toEqual(["0x3e8", "0x3e9", "0x3ea"]);
    expect(record.chunks.filter((chunk: { state: string }) => chunk.state === "split")).toHaveLength(2);
    expect(record.chunks[0].error.rpcMessage).toContain("retry with the range 1000-1000");
  });

  it.each([
    { name: "no suggested range", suffix: "" },
    { name: "out-of-range suggestion", suffix: ", retry with the range 1000-9999999" },
  ])("bisects capped log chunks with $name", async ({ suffix }) => {
    const ranges: string[][] = [];
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method !== "eth_getLogs") return rpcResponse(body.id, header(body.params[0]));
      const { fromBlock, toBlock } = body.params[0];
      const start = BigInt(fromBlock);
      const end = BigInt(toBlock);
      ranges.push([start.toString(), end.toString()]);
      if (end - start > 1n) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: {
          code: -32602, message: `query exceeds max results 10000${suffix}`,
        } }));
      }
      return rpcResponse(body.id, []);
    });
    const record = await invoke(["--block", "1003"], "ethereum", "eth_getLogs", '[{"fromBlock":"1000","toBlock":"1003"}]');
    expect(ranges).toEqual([["1000", "1003"], ["1000", "1001"], ["1002", "1003"]]);
    expect(record).toMatchObject({ state: "empty", reason: "empty-result-not-proof-of-absence", result: [] });
  });

  it("withholds earlier split results when a single block exceeds the result cap", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method !== "eth_getLogs") return rpcResponse(body.id, header(body.params[0]));
      const { fromBlock, toBlock } = body.params[0];
      if (fromBlock === "0x3e8" && toBlock === "0x3e8") {
        return rpcResponse(body.id, [{ blockNumber: fromBlock, blockHash: HASH }]);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: {
        code: -32602, message: `query exceeds max results 10000 ${KEY}`,
      } }));
    });
    const record = await invoke(["--block", "1001"], "ethereum", "eth_getLogs", '[{"fromBlock":"1000","toBlock":"1001"}]');
    expect(record).toMatchObject({
      state: "error", reason: "result-cap", result: null,
      error: { rpcCode: -32602, message: "query exceeds max results 10000 [REDACTED]", rpcMessage: "query exceeds max results 10000 [REDACTED]" },
    });
    expect(record.chunks.map((chunk: { state: string }) => chunk.state)).toEqual(["split", "ok", "error"]);
    expect(stdout.join("")).not.toContain(KEY);
    expect(process.exitCode).toBe(1);
  });

  it("withholds results when the pinned block changes during the read", async () => {
    let headers = 0;
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "eth_call") return rpcResponse(body.id, "0x1");
      headers++;
      return rpcResponse(body.id, { ...header(body.params[0]), hash: headers === 1 ? HASH : `0x${"b".repeat(64)}` });
    });
    const record = await invoke(["--block", "1000"]);
    expect(record).toMatchObject({ state: "error", reason: "block-changed", result: null });
  });

  it("matches batch responses by ID and records member-level empty states", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (!Array.isArray(body)) return rpcResponse(body.id, header(body.params[0]));
      return new Response(JSON.stringify(body.map((item, index) => ({ jsonrpc: "2.0", id: item.id, result: index === 0 ? "0x" : "0x1" })).reverse()));
    });
    const record = await invoke(["--block", "1000"], "ethereum", "batch", '[{"method":"eth_getCode","params":["0x1111111111111111111111111111111111111111"]},{"method":"eth_getBalance","params":["0x1111111111111111111111111111111111111111"]}]');
    expect(record.result.map((item: { result: unknown; state: string }) => [item.result, item.state])).toEqual([["0x", "empty"], ["0x1", "ok"]]);
  });

  it("rejects a batch exceeding 100 members", async () => {
    const params = JSON.stringify(Array.from({ length: 101 }, () => ({ method: "eth_getCode", params: ["0x1111111111111111111111111111111111111111"] })));
    const record = await invoke(["--block", "1000"], "ethereum", "batch", params);
    expect(record).toMatchObject({ state: "error", reason: "invalid-arguments", result: null });
  });

  it.each(["aptos", "movement"])("pins %s account reads by ledger version and records containing block provenance", async (chain) => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes("blocks/by_version/1000")) {
        return new Response(JSON.stringify({ block_height: "123", block_hash: HASH, block_timestamp: "1700000000000000", first_version: "990", last_version: "1010" }));
      }
      expect(String(url)).toContain("ledger_version=1000");
      return new Response(JSON.stringify({ type: "0x1::fungible_asset::Metadata", data: { decimals: 6 } }));
    });
    const record = await invoke(["--block", "1000"], chain, "GET /accounts/0x1/resource/0x1::fungible_asset::Metadata", "{}");
    expect(record).toMatchObject({ state: "ok", ledgerVersion: "1000", block: { number: "123", hash: HASH, timestamp: "2023-11-14T22:13:20.000Z" } });
    expect(record.requestUrl).toContain("/v1/accounts/");
  });

  it("sends Starknet numeric block_id and captures its header", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.params.block_id).toEqual({ block_number: 1000 });
      return rpcResponse(body.id, body.method === "starknet_call" ? ["0x1"] : { block_number: 1000, block_hash: "0x123", timestamp: 1700000000 });
    });
    const record = await invoke(["--block", "1000"], "starknet", "starknet_call", '{"request":{"contract_address":"0x1","entry_point_selector":"0x2","calldata":[]}}');
    expect(record).toMatchObject({ state: "ok", block: { number: "1000", hash: "0x123", timestamp: "2023-11-14T22:13:20.000Z" }, result: ["0x1"] });
  });

  it("refuses to fabricate TRON historical provenance without sending a read", async () => {
    const record = await invoke(["--block", "1000"], "tron", "triggerconstantcontract", "{}");
    expect(record).toMatchObject({ state: "unsupported", reason: "unsupported-pinned-state", result: null, block: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins transaction-count reads for BSC nonce evidence", async () => {
    const record = await invoke(["--block", "1000"], "bsc", "eth_getTransactionCount", '["0x1111111111111111111111111111111111111111"]');
    expect(record).toMatchObject({ state: "ok", params: ["0x1111111111111111111111111111111111111111", "0x3e8"], result: "0x1" });
  });

  it("returns unsupported for an unregistered network without sending a read", async () => {
    const record = await invoke(["--block", "1000"], "not-a-network");
    expect(record).toMatchObject({ state: "unsupported", reason: "unsupported-chain-provider", result: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["solana", "getAccountInfo", '["11111111111111111111111111111111",{"minContextSlot":1000}]'],
    ["solana", "getTokenSupply", '["11111111111111111111111111111111"]'],
    ["solana", "getProgramAccounts", '["11111111111111111111111111111111"]'],
    ["sui", "suix_getBalance", '["0x1","0x2::sui::SUI"]'],
    ["sui", "sui_tryGetPastObject", '["0x1","1000"]'],
  ])("refuses fabricated %s state provenance for %s before any fetch", async (chain, method, params) => {
    const record = await invoke(["--provider", chain === "solana" ? "drpc" : "dwellir", "--block", "1000"], chain, method, params);
    expect(record).toMatchObject({ state: "unsupported", reason: "unsupported-pinned-state", block: null, result: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records finalized Solana block provenance and full execution data", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.params[0]).toBe(1000);
      expect(body.params[1].commitment).toBe("finalized");
      return rpcResponse(body.id, { blockhash: "1".repeat(32), blockTime: 1700000000, transactions: [] });
    });
    const record = await invoke(["--provider", "alchemy", "--block", "1000"], "solana", "getBlock", '[1000,{"transactionDetails":"full","maxSupportedTransactionVersion":0}]');
    expect(record).toMatchObject({ state: "ok", slot: "1000", block: { number: "1000", hash: "1".repeat(32), timestamp: "2023-11-14T22:13:20.000Z" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves dRPC's HTTP-400 entitlement diagnosis on its documented Solana route", async () => {
    vi.stubEnv("DRPC_API_KEY", "drpc-secret");
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit) => {
      expect(String(url)).toBe("https://lb.drpc.live/solana");
      expect(init.headers).toMatchObject({ "Drpc-Key": "drpc-secret" });
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        error: { code: 35, message: "chain is not available on free plan drpc-secret" } }), { status: 400 });
    });
    const record = await invoke(["--provider", "drpc", "--block", "1000"], "solana", "getBlock", "[1000]");
    expect(record).toMatchObject({ state: "error", reason: "rpc-error", result: null, block: null,
      endpoint: "https://lb.drpc.live/solana", error: { httpStatus: 400, rpcCode: 35,
        rpcMessage: "chain is not available on free plan [REDACTED]" } });
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).not.toContain("drpc-secret");
  });

  it.each([
    { jsonrpc: "2.0", id: 1, result: "0x1" },
    { jsonrpc: "2.0", id: 99, error: { code: 35, message: "wrong response" } },
  ])("never accepts a non-error or mismatched envelope on HTTP 400: %j", async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 400 }));
    const record = await invoke(["--block", "1000"]);
    expect(record).toMatchObject({ state: "error", reason: "http-error", result: null, block: null,
      error: { httpStatus: 400 } });
  });

  it("withholds a Solana transaction from another slot", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "getTransaction" ? { slot: 999 } : { blockhash: "1".repeat(32), blockTime: 1700000000 });
    });
    const record = await invoke(["--provider", "alchemy", "--block", "1000"], "solana", "getTransaction", '["signature"]');
    expect(record).toMatchObject({ state: "error", reason: "block-pin-mismatch", result: null });
  });

  it("retains Solana produced-slot range chunks, not an invented account census", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "getBlocks" ? [body.params[0], body.params[1]] : { blockhash: "1".repeat(32), blockTime: 1700000000 });
    });
    const record = await invoke(["--provider", "alchemy", "--block", "1001"], "solana", "getBlocks", "[500,1001]");
    expect(record).toMatchObject({ state: "ok", range: { fromSlot: "500", toSlot: "1001" }, result: [500, 999, 1000, 1001] });
    expect(record.chunks).toHaveLength(2);
  });

  it("pins Sui transactions to checkpoint membership and time", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "sui_getCheckpoint"
        ? { sequenceNumber: "1000", digest: "1".repeat(32), timestampMs: "1700000000000", transactions: ["transaction-digest"] }
        : { digest: "transaction-digest", checkpoint: "1000", effects: {} });
    });
    const record = await invoke(["--block", "1000"], "sui", "sui_getTransactionBlock", '["transaction-digest",{"showEffects":true}]');
    expect(record).toMatchObject({ state: "ok", checkpoint: "1000", block: { number: "1000", timestamp: "2023-11-14T22:13:20.000Z" } });
  });

  it("withholds a Sui transaction absent from the pinned checkpoint", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "sui_getCheckpoint"
        ? { sequenceNumber: "1000", digest: "1".repeat(32), timestampMs: "1700000000000", transactions: [] }
        : { digest: "transaction-digest", checkpoint: "1000" });
    });
    const record = await invoke(["--block", "1000"], "sui", "sui_getTransactionBlock", '["transaction-digest"]');
    expect(record).toMatchObject({ state: "error", reason: "block-pin-mismatch", result: null });
  });

  it.each(["fraxtal", "kaia", "hemi", "plume", "filecoin", "rootstock"])("uses the canonical public %s endpoint without sending a Dwellir key", async (chain) => {
    const record = await invoke(["--provider", "public", "--block", "1000"], chain);
    expect(record).toMatchObject({ provider: "public", state: "ok", block: { number: "1000" } });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).not.toHaveProperty("X-Api-Key");
      expect(init.headers).not.toHaveProperty("Authorization");
    }
  });

  it.each(["public", "drpc"])("keeps missing Filecoin MsgMeta on %s unavailable without archive fallback", async (provider) => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        error: { code: 1, message: "failed to create Ethereum block from Filecoin tipset: failed to load msgmeta: ipld: could not find" } }));
    });
    const record = await invoke(["--provider", provider, "--block", "6429411"], "filecoin",
      "eth_getBlockByNumber", '["0x621ae3",false]');
    expect(record).toMatchObject({ state: "error", reason: "rpc-error", block: null, result: null,
      error: { rpcCode: 1, rpcMessage: expect.stringContaining("failed to load msgmeta") } });
    expect(process.exitCode).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("registers Corn Maizenet research reads without leaking a keyed provider credential", async () => {
    const record = await invoke(["--provider", "public", "--block", "1711897"], "corn");
    expect(record).toMatchObject({ state: "ok", endpoint: "https://maizenet-rpc.usecorn.com", block: { number: "1711897" } });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://maizenet-rpc.usecorn.com");
      expect(init.headers).not.toHaveProperty("Authorization");
      expect(init.headers).not.toHaveProperty("X-Api-Key");
      expect(init.headers).not.toHaveProperty("Drpc-Key");
    }
  });

  it("leaves failed Corn transport unavailable rather than zero or unsupported", async () => {
    fetchMock.mockRejectedValue(new TypeError("DNS unavailable"));
    const record = await invoke(["--provider", "public", "--block", "1711897"], "corn");
    expect(record).toMatchObject({ state: "error", reason: "transport-error", result: null, block: null,
      endpoint: "https://maizenet-rpc.usecorn.com" });
  });

  it("uses Alchemy bearer authentication and never records its key", async () => {
    vi.stubEnv("ALCHEMY_API_KEY", "alchemy-secret");
    const record = await invoke(["--provider", "alchemy", "--block", "1000"], "bsc");
    expect(record).toMatchObject({ provider: "alchemy", endpoint: "https://bnb-mainnet.g.alchemy.com/v2/", state: "ok" });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("alchemy-secret");
      expect(init.headers).toMatchObject({ Authorization: "Bearer alchemy-secret" });
      expect(init.headers).not.toHaveProperty("X-Api-Key");
    }
    expect(stdout.join("")).not.toContain("alchemy-secret");
  });

  it("uses dRPC header authentication on a keyless network URL and redacts provider echoes", async () => {
    vi.stubEnv("DRPC_API_KEY", "drpc-secret");
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, body.method === "eth_call" ? { echo: "drpc-secret" } : header(body.params[0]));
    });
    const record = await invoke(["--provider", "drpc", "--block", "1000"], "bsc");
    expect(record).toMatchObject({ provider: "drpc", endpoint: "https://lb.drpc.org/ogrpc?network=bsc", state: "ok", result: { echo: "[REDACTED]" } });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("drpc-secret");
      expect(init.headers).toMatchObject({ "Drpc-Key": "drpc-secret" });
      expect(init.headers).not.toHaveProperty("X-Api-Key");
    }
    expect(stdout.join("")).not.toContain("drpc-secret");
  });

  it("pins Hedera mirror contract reads and preserves the consensus timestamp", async () => {
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit) => {
      if (String(url).includes("/blocks/1000")) {
        return new Response(JSON.stringify({ number: 1000, hash: HASH, timestamp: { to: "1700000000.123456789" } }));
      }
      expect(String(url)).toMatch(/\/contracts\/call$/);
      expect(JSON.parse(String(init.body))).toMatchObject({ block: "0x3e8", estimate: false });
      return new Response(JSON.stringify({ result: "0x1" }));
    });
    const record = await invoke(["--provider", "public", "--block", "1000"], "hedera");
    expect(record).toMatchObject({ state: "ok", consensusTimestamp: "1700000000.123456789", result: "0x1", block: { number: "1000", hash: HASH } });
  });

  it.each([64, 96])("accepts exactly %i hexadecimal digits in a Hedera pinned hash", async length => {
    const hash = `0x${"A".repeat(length)}`;
    fetchMock.mockImplementation(async (url: string | URL) => new Response(JSON.stringify(
      String(url).includes("/blocks/")
        ? { number: 1000, hash, timestamp: { to: "1700000000.123456789" } }
        : { result: "0x1" },
    )));
    const record = await invoke(["--provider", "public", "--block", "1000"], "hedera");
    expect(record).toMatchObject({ state: "ok", result: "0x1", block: { hash: hash.toLowerCase() } });
  });

  it.each([63, 65, 95, 97, 128])("keeps a %i-digit Hedera hash unavailable", async length => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      number: 1000, hash: `0x${"a".repeat(length)}`, timestamp: { to: "1700000000.123456789" },
    })));
    const record = await invoke(["--provider", "public", "--block", "1000"], "hedera");
    expect(record).toMatchObject({ state: "error", reason: "missing-block-header", result: null, block: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps non-hexadecimal Hedera hashes unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      number: 1000, hash: `0x${"a".repeat(63)}g`, timestamp: { to: "1700000000.123456789" },
    })));
    const record = await invoke(["--provider", "public", "--block", "1000"], "hedera");
    expect(record).toMatchObject({ state: "error", reason: "missing-block-header", result: null, block: null });
  });

  it("does not turn a pruned Hedera call into an empty or positive result", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => String(url).includes("/blocks/")
      ? new Response(JSON.stringify({ number: 1000, hash: HASH, timestamp: { to: "1700000000.123456789" } }))
      : new Response(JSON.stringify({ _status: { messages: [{ message: "historical state unavailable" }] } })));
    const record = await invoke(["--provider", "public", "--block", "1000"], "hedera");
    expect(record).toMatchObject({ state: "error", reason: "native-api-error", result: null });
  });

  it("scopes public Sui object state through Checkpoint.query, never current root state", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.variables.cp).toBe(1000);
      const checkpoint = { sequenceNumber: "1000", digest: "1".repeat(32), timestamp: "2023-11-14T22:13:20Z" };
      if (body.variables.address) {
        expect(body.query).toContain("query { object(address: $address)");
        return new Response(JSON.stringify({ data: { checkpoint: { ...checkpoint, query: { object: { address: "0x1", version: "99", digest: "2".repeat(32) } } } } }));
      }
      return new Response(JSON.stringify({ data: { checkpoint } }));
    });
    const record = await invoke(["--provider", "public", "--block", "1000"], "sui", "sui_getObject", '["0x1"]');
    expect(record).toMatchObject({ state: "ok", checkpoint: "1000", result: { address: "0x1", version: "99" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("withholds partial GraphQL data when the historical checkpoint is outside retention", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { checkpoint: null }, errors: [{ message: "outside retention" }] })));
    const record = await invoke(["--provider", "public", "--block", "1000"], "sui", "suix_getBalance", '["0x1","0x2::sui::SUI"]');
    expect(record).toMatchObject({ state: "error", reason: "graphql-error", result: null });
  });

  it.each([1000, 1001])("requires Alchemy account-archive context to equal the requested slot (returned %s)", async (contextSlot) => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "getAccountInfo") {
        expect(body.params[1]).toMatchObject({ slot: 1000, commitment: "finalized" });
        return rpcResponse(body.id, { context: { slot: contextSlot }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: ["AA==", "base64"] } });
      }
      return rpcResponse(body.id, { blockhash: "1".repeat(32), blockTime: 1700000000 });
    });
    const record = await invoke(["--provider", "alchemy", "--block", "1000"], "solana", "getAccountInfo", '["11111111111111111111111111111111",{"encoding":"base64"}]');
    expect(record.state).toBe(contextSlot === 1000 ? "ok" : "error");
    expect(record.endpoint).toBe("https://solana-mainnet.g.alchemy.com/v2/");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe(record.endpoint);
      expect(init.headers).toMatchObject({ Authorization: "Bearer alchemy-test-key" });
    }
    if (contextSlot !== 1000) expect(record).toMatchObject({ reason: "block-pin-mismatch", result: null });
  });

  it("rejects minContextSlot instead of treating it as an Alchemy archive pin", async () => {
    fetchMock.mockImplementation(async (_url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return rpcResponse(body.id, { blockhash: "1".repeat(32), blockTime: 1700000000 });
    });
    const record = await invoke(["--provider", "alchemy", "--block", "1000"], "solana", "getAccountInfo", '["11111111111111111111111111111111",{"minContextSlot":1000}]');
    expect(record).toMatchObject({ state: "error", reason: "invalid-arguments", result: null });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).method)).not.toContain("getAccountInfo");
  });

  it("explicitly reports unsupported for the retained Hedera bytecode read before fetching", async () => {
    const record = await invoke(["--provider", "public", "--block", "100919357"], "hedera", "eth_getCode", '["0xf07781182b47e728b040f9e35321260e359ff9f7"]');
    expect(record).toMatchObject({ state: "unsupported", reason: "unsupported-pinned-state", result: null, block: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
