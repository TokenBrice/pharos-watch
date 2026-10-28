import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { DWELLIR_NATIVE_ENDPOINTS } from "@shared/lib/dwellir-native-endpoints";
import { PUBLIC_RPC_URLS } from "@shared/lib/chain-rpc-registry";
import { TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES, TRON_RPC_MAX_RESPONSE_BYTES,
  TRON_SOLID_HEAD_MAX_RESPONSE_BYTES } from "@shared/lib/tron-jsonrpc";
import { createDwellirNativeCapability } from "../../../lib/dwellir-native";
import * as budget from "../../../lib/rpc-provider-budget";
import { fetchStarknetTotalSupply } from "../starknet";
import { fetchTronErc20TotalSupply } from "../onchain";
import { fetchMoveFungibleAssetSupply } from "../token-supply";

const KEY = "native-test-key-placeholder";
const ADDRESS = "0x1234";
const SIGNAL = new AbortController().signal;
const TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const native = createDwellirNativeCapability(KEY);
const ctx = { dwellirNative: native };

beforeEach(() => {
  vi.spyOn(budget, "recordDwellirCredits").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native Dwellir supported-operation preference", () => {
  it.each(["aptos", "movement"] as const)("reads %s through Dwellir first with scoped auth/credits", async network => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === network)!.baseUrl;
    const chainId = network === "aptos" ? 1 : 126;
    const fetcher = mockFetch([
      { match: base, respond: request => ({ body: request.url === base
        ? { chain_id: chainId, ledger_version: "100", oldest_ledger_version: "50" }
        : request.url.includes("ConcurrentSupply")
          ? { type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "123" } } }
          : { type: "0x1::fungible_asset::Metadata", data: { decimals: 6 } } }) },
    ], { requireMatch: true });
    expect(await fetchMoveFungibleAssetSupply(ADDRESS, SIGNAL, `https://${network}.example/v1`, ctx,
      undefined, network)).toEqual({ rawSupply: 123n, decimals: 6, ledgerVersion: "100" });
    const history = fetcher.getHistory();
    expect(history[0]?.url).toBe(base);
    expect(history.every(request => request.headers["x-api-key"] === KEY)).toBe(true);
    expect(history.slice(1).every(request => request.url.endsWith("ledger_version=100"))).toBe(true);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(3);
    expect(budget.recordDwellirCredits).toHaveBeenCalledWith(1);
  });

  it.each(["aptos", "movement"] as const)("falls back for %s at the same ledger pin without leaking auth", async network => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === network)!.baseUrl;
    const incumbent = PUBLIC_RPC_URLS[network];
    const chainId = network === "aptos" ? 1 : 126;
    const fetcher = mockFetch([
      { match: base, respond: request => ({ body: request.url === base
        ? { chain_id: chainId, ledger_version: "100", oldest_ledger_version: "50" }
        : {} }) },
      { match: incumbent, respond: request => ({ body: request.url === incumbent
        ? { chain_id: chainId, ledger_version: "200" }
        : request.url.includes("ConcurrentSupply")
          ? { type: "0x1::fungible_asset::ConcurrentSupply", data: { current: { value: "5" } } }
          : { type: "0x1::fungible_asset::Metadata", data: { decimals: 6 } } }) },
    ], { requireMatch: true });
    expect(await fetchMoveFungibleAssetSupply(ADDRESS, SIGNAL, incumbent, ctx))
      .toEqual({ rawSupply: 5n, decimals: 6, ledgerVersion: "100" });
    const history = fetcher.getHistory();
    expect(history[0]?.url).toBe(base);
    const fallback = history.filter(request => request.url.startsWith(incumbent));
    expect(fallback).toHaveLength(3);
    expect(fallback.every(request => !request.headers["x-api-key"])).toBe(true);
    expect(fallback.slice(1).every(request => request.url.endsWith("ledger_version=100"))).toBe(true);
  });

  it.each(["aptos", "movement"] as const)("leaves %s unchanged without admission", async network => {
    const url = PUBLIC_RPC_URLS[network];
    const fetcher = mockFetch([{ match: url, body: {} }], { requireMatch: true });
    expect(await fetchMoveFungibleAssetSupply(ADDRESS, SIGNAL, url)).toBeNull();
    expect(fetcher.getHistory()).toHaveLength(1);
    expect(budget.recordDwellirCredits).not.toHaveBeenCalled();
  });

  it.each(["aptos", "movement"] as const)("fails %s closed when retained history is not reported", async network => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === network)!.baseUrl;
    const chainId = network === "aptos" ? 1 : 126;
    const fetcher = mockFetch([
      { match: PUBLIC_RPC_URLS[network], body: {} },
      { match: base, body: { chain_id: chainId, ledger_version: "200" } },
    ], { requireMatch: true });
    expect(await fetchMoveFungibleAssetSupply(ADDRESS, SIGNAL, PUBLIC_RPC_URLS[network], ctx)).toBeNull();
    expect(fetcher.getHistory().filter(request => request.url.startsWith(base))).toHaveLength(1);
  });

  it.each(["aptos", "movement"] as const)("never probes %s below its retained floor to satisfy an old clock", async network => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === network)!.baseUrl;
    const chainId = network === "aptos" ? 1 : 126;
    const fetcher = mockFetch([
      { match: PUBLIC_RPC_URLS[network], body: {} },
      { match: base, respond: request => ({ body: request.url === base
        ? { chain_id: chainId, ledger_version: "200", ledger_timestamp: "200000000", oldest_ledger_version: "150" }
        : { first_version: "150", last_version: "200", block_timestamp: "200000000" } }) },
    ], { requireMatch: true });
    expect(await fetchMoveFungibleAssetSupply(ADDRESS, SIGNAL, PUBLIC_RPC_URLS[network], ctx,
      { clockSec: 100, expectedChainId: chainId })).toBeNull();
    expect(fetcher.getHistory().filter(request => request.url.startsWith(base)).map(request => request.url))
      .toEqual([base, `${base}/blocks/by_version/200?with_transactions=false`]);
  });

  it("tries Dwellir Starknet first, then configured and Cartridge fallbacks with unchanged block semantics", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "starknet")!.baseUrl;
    const fetcher = mockFetch([
      { match: base, body: { result: ["bad", "0x0"] } },
      { match: "https://starknet.example", body: { error: { message: "unavailable" } } },
      { match: "https://api.cartridge.gg", body: { result: ["0xa", "0x1"] } },
    ], { requireMatch: true });
    expect(await fetchStarknetTotalSupply({ contract: ADDRESS, signal: SIGNAL, rpcUrl: "https://starknet.example", ctx }))
      .toBe((1n << 128n) + 10n);
    const history = fetcher.getHistory();
    expect(history.map(request => new URL(request.url).host))
      .toEqual([new URL(base).host, "starknet.example", "api.cartridge.gg"]);
    expect(history.map(request => request.headers["x-api-key"])).toEqual([KEY, undefined, undefined]);
    expect(history.every(request => JSON.parse(request.body!).params.block_id === "latest")).toBe(true);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(1);
  });

  it("stops on Dwellir Starknet success, and retains incumbent-only reads without admission", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "starknet")!.baseUrl;
    const fetcher = mockFetch([
      { match: base, body: { result: ["0x1", "0x0"] } },
      { match: "https://api.cartridge.gg", body: { result: ["0x2", "0x0"] } },
    ], { requireMatch: true });
    expect(await fetchStarknetTotalSupply({ contract: ADDRESS, signal: SIGNAL, ctx })).toBe(1n);
    expect(await fetchStarknetTotalSupply({ contract: ADDRESS, signal: SIGNAL })).toBe(2n);
    expect(fetcher.getHistory()).toHaveLength(2);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(1);
  });

  it("tries Dwellir constant reads before TronGrid without forwarding provider credentials", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "tron")!.baseUrl;
    const fetcher = mockFetch([
      { match: `${base}/wallet/triggerconstantcontract`, body: { result: { result: false } } },
      { match: "https://api.trongrid.io/wallet/triggerconstantcontract", body: { result: { result: true }, constant_result: ["0a"] } },
    ], { requireMatch: true });
    expect(await fetchTronErc20TotalSupply(TRON_CONTRACT, SIGNAL, { ...ctx, trongridApiKey: "tron-test-key" })).toBe(10n);
    expect(fetcher.getHistory().map(request => request.headers["x-api-key"])).toEqual([KEY, undefined]);
    expect(fetcher.getHistory().map(request => request.headers["tron-pro-api-key"])).toEqual([undefined, "tron-test-key"]);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(1);
  });

  it("stops on Dwellir TRON success, retains unadmitted reads, and refuses pinned TRON", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "tron")!.baseUrl;
    const fetcher = mockFetch([
      { match: base, body: { result: { result: true }, constant_result: ["01"] } },
      { match: "https://api.trongrid.io", body: { result: { result: false } } },
    ], { requireMatch: true });
    expect(await fetchTronErc20TotalSupply(TRON_CONTRACT, SIGNAL, ctx)).toBe(1n);
    expect(await fetchTronErc20TotalSupply(TRON_CONTRACT, SIGNAL)).toBeNull();
    expect(await fetchTronErc20TotalSupply(TRON_CONTRACT, SIGNAL, {
      ...ctx, observedBlock: { chain: "tron", number: 100, timestamp: 1000 },
    })).toBeNull();
    expect(fetcher.getHistory()).toHaveLength(2);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(1);
  });

  it.each(DWELLIR_NATIVE_ENDPOINTS)("blocks disabled $network before any physical request or charge", async endpoint => {
    const disabled = createDwellirNativeCapability(KEY, new Set([endpoint.network]));
    const fetcher = mockFetch([], { requireMatch: true });
    await expect(disabled.readJson(endpoint.network, "", SIGNAL)).rejects.toThrow("routing disabled");
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.recordDwellirCredits).not.toHaveBeenCalled();
  });

  it("rejects TRON events and unrelated Starknet methods before fetching", async () => {
    const fetcher = mockFetch([], { requireMatch: true });
    await expect(native.readJson("tron", "/v1/contracts/test/events", SIGNAL, ctx)).rejects.toThrow();
    await expect(native.readJson("starknet", "", SIGNAL, ctx, { method: "starknet_getEvents" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.recordDwellirCredits).not.toHaveBeenCalled();
  });

  it("meters error responses and sanitizes provider bodies without exposing keyed URLs", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "starknet")!.baseUrl;
    const fetcher = mockFetch([{ match: base, outcomes: [
      { body: "unavailable", status: 503 }, { body: KEY, status: 200 },
    ] }], { requireMatch: true });
    await expect(native.readJson("starknet", "", SIGNAL, ctx, { method: "starknet_call" })).rejects.toThrow();
    const error = await native.readJson("starknet", "", SIGNAL, ctx, { method: "starknet_call" }).catch(error => error);
    expect(String(error)).not.toContain(KEY);
    expect(fetcher.getHistory().every(request => request.url === `${base}/` && request.headers["x-api-key"] === KEY)).toBe(true);
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(2);
  });
});

describe("native credential redirect scoping", () => {
  it.each(DWELLIR_NATIVE_ENDPOINTS)("uses Worker-supported redirect refusal for $network", async endpoint => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("X-Api-Key")).toBe(KEY);
      return Response.json({ result: ["0x1", "0x0"] });
    });
    vi.stubGlobal("fetch", fetcher);
    const path = endpoint.protocol === "tron-http" ? endpoint.allowedPath : "";
    const body = endpoint.protocol === "aptos-rest" ? undefined : { method: "starknet_call" };
    expect(await native.readJson(endpoint.network, path, SIGNAL, ctx, body))
      .toEqual({ result: ["0x1", "0x0"] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(DWELLIR_NATIVE_ENDPOINTS.flatMap(endpoint =>
    [301, 302, 303, 307, 308].map(status => ({ endpoint, status })),
  ))("rejects $status from $endpoint.network without forwarding credentials", async ({ endpoint, status }) => {
    const response = new Response(JSON.stringify({ result: ["0x1", "0x0"] }), {
      status, headers: { Location: "https://unapproved.example/native" },
    });
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => response);
    vi.stubGlobal("fetch", fetcher);
    const path = endpoint.protocol === "tron-http" ? endpoint.allowedPath : "";
    const body = endpoint.protocol === "aptos-rest" ? undefined : { method: "starknet_call" };
    await expect(native.readJson(endpoint.network, path, SIGNAL, ctx, body)).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${endpoint.baseUrl}${path}`);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(response.bodyUsed).toBe(true);
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe("native RPC error credential redaction", () => {
  it("redacts a credential echoed in a Starknet RPC error before reader diagnostics", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "starknet")!.baseUrl;
    mockFetch([
      { match: "https://api.cartridge.gg", body: { error: { message: "unavailable" } } },
      { match: base, body: { error: { message: `unauthorized ${KEY}` } } },
    ], { requireMatch: true });
    const error = await fetchStarknetTotalSupply({ contract: ADDRESS, signal: SIGNAL, ctx }).catch(error => error);
    expect(String(error)).not.toContain(KEY);
    expect(String(error)).toContain("unavailable");
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(1);
  });
});

describe("curated native endpoint preservation", () => {
  it("keeps an explicitly configured Dwellir Starknet URL keyless without supplemental admission", async () => {
    const base = DWELLIR_NATIVE_ENDPOINTS.find(entry => entry.network === "starknet")!.baseUrl;
    const fetcher = mockFetch([{ match: base, body: { result: ["0x2", "0x0"] } }], { requireMatch: true });
    expect(await fetchStarknetTotalSupply({ contract: ADDRESS, signal: SIGNAL, rpcUrl: base })).toBe(2n);
    expect(fetcher.getHistory()).toHaveLength(1);
    expect(fetcher.getHistory()[0]?.headers["x-api-key"]).toBeUndefined();
    expect(budget.recordDwellirCredits).not.toHaveBeenCalled();
  });
});

describe("admitted Tron JSON-RPC and solidified-head reads", () => {
  const address = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
  const topic = `0x${"ab".repeat(32)}`;
  const rpc = (method: string, params: unknown[]) => ({ jsonrpc: "2.0", id: 1, method, params });
  const filter = { fromBlock: "0x1", toBlock: "0x2710", address, topics: [[topic]] };

  it.each([
    ["/jsonrpc", rpc("eth_blockNumber", [])],
    ["/jsonrpc", rpc("eth_getBlockByNumber", ["0x123", false])],
    ["/jsonrpc", rpc("eth_getLogs", [filter])],
    ["/jsonrpc", rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }])],
    ["/walletsolidity/getnowblock", {}],
  ])("admits %s %j with scoped auth and one credit", async (path, body) => {
    const fetcher = mockFetch([{ match: "https://api-tron-mainnet.n.dwellir.com", body: { result: [] } }], { requireMatch: true });
    await expect(native.readJson("tron", String(path), SIGNAL, undefined, body)).resolves.toEqual({ result: [] });
    expect(fetcher.getHistory()).toHaveLength(1);
    expect(fetcher.getHistory()[0].headers["x-api-key"]).toBe(KEY);
    expect(fetcher.getHistory()[0].url).not.toContain(KEY);
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([
    ["/jsonrpc", rpc("eth_call", [{ to: address, data: "0x1234" }, "latest"])],
    ["/jsonrpc", rpc("eth_getBlockByNumber", ["0x123", true])],
    ["/jsonrpc", rpc("eth_getBlockByNumber", ["pending", false])],
    ["/jsonrpc", rpc("eth_getLogs", [{ ...filter, toBlock: "0x2711" }])],
    ["/jsonrpc", rpc("eth_getLogs", [{ ...filter, fromBlock: "0x2", toBlock: "0x1" }])],
    ["/jsonrpc", rpc("eth_getLogs", [{ ...filter, address: "0x12" }])],
    ["/jsonrpc", rpc("eth_getLogs", [{ ...filter, topics: [["0x12"]] }])],
    ["/jsonrpc", rpc("eth_getLogs", [{ ...filter, blockHash: topic }])],
    ["/jsonrpc", rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])],
    ["/jsonrpc", [rpc("eth_blockNumber", [])]],
    ["/walletsolidity/getnowblock", { detail: false }],
    ["/wallet/gettransactioninfobyblocknum", { num: 1 }],
    ["/jsonrpc?method=eth_getLogs", rpc("eth_blockNumber", [])],
  ])("refuses unadmitted %s %j before fetching or charging", async (path, body) => {
    const fetcher = mockFetch([], { requireMatch: true });
    await expect(native.readJson("tron", String(path), SIGNAL, undefined, body)).rejects.toThrow("outside the admitted");
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.recordDwellirCredits).not.toHaveBeenCalled();
  });

  it("requires an admitted credential and honors Tron disablement for the newly admitted paths", async () => {
    expect(() => createDwellirNativeCapability(" ")).toThrow("requires an admitted credential");
    const disabled = createDwellirNativeCapability(KEY, new Set(["tron"]));
    const fetcher = mockFetch([], { requireMatch: true });
    await expect(disabled.readJson("tron", "/jsonrpc", SIGNAL, undefined, rpc("eth_blockNumber", []))).rejects.toThrow("routing disabled");
    await expect(disabled.readJson("tron", "/walletsolidity/getnowblock", SIGNAL, undefined, {})).rejects.toThrow("routing disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the RPC body cap and overflow error identity while charging the received response", async () => {
    const response = new Response(" ".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1));
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    await expect(native.readJson("tron", "/jsonrpc", SIGNAL, undefined, rpc("eth_blockNumber", [])))
      .rejects.toMatchObject({ name: "ResponseBodyTooLargeError" });
    expect(response.bodyUsed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("admits a larger body only for validated unfiltered single-block context", async () => {
    const result = { result: "x".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
    await expect(native.readJson("tron", "/jsonrpc", SIGNAL, undefined,
      rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]))).resolves.toEqual(result);
    await expect(native.readJson("tron", "/jsonrpc", SIGNAL, undefined,
      rpc("eth_getLogs", [{ ...filter, toBlock: "0x1" }]))).rejects.toMatchObject({ name: "ResponseBodyTooLargeError" });
    expect(budget.recordDwellirCredits).toHaveBeenCalledTimes(2);
  });

  it("enforces the2MiB context cap on streamed bytes even with a smaller declared length", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(TRON_RPC_BLOCK_CONTEXT_MAX_RESPONSE_BYTES / 2)); },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Length": "1" } })));
    await expect(native.readJson("tron", "/jsonrpc", SIGNAL, undefined,
      rpc("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]))).rejects.toMatchObject({ name: "ResponseBodyTooLargeError" });
    expect(cancelled).toBe(true);
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("admits a bounded transaction-bearing solidity head larger than an RPC response", async () => {
    const result = { transactions: "x".repeat(TRON_RPC_MAX_RESPONSE_BYTES + 1) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(result)));
    await expect(native.readJson("tron", "/walletsolidity/getnowblock", SIGNAL, undefined, {})).resolves.toEqual(result);
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("rejects an oversized solidity head rather than reading it unbounded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(" ".repeat(TRON_SOLID_HEAD_MAX_RESPONSE_BYTES + 1))));
    await expect(native.readJson("tron", "/walletsolidity/getnowblock", SIGNAL, undefined, {}))
      .rejects.toMatchObject({ name: "ResponseBodyTooLargeError" });
    expect(budget.recordDwellirCredits).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("redacts a key echoed in a Tron RPC error before it reaches reader diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: `unauthorized ${KEY}` } })));
    expect(await native.readJson("tron", "/jsonrpc", SIGNAL, undefined, rpc("eth_blockNumber", [])))
      .toEqual({ error: { message: "unauthorized [redacted]" } });
  });
});
