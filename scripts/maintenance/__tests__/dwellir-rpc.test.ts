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
    expect(record).toMatchObject({ state: "error", reason: "unsupported-pinned-state", result: null, block: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
