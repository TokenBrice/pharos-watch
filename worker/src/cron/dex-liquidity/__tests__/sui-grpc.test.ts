import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { DexRequestBudget } from "@shared/types/measured-execution";
import { SuiClmmShadowHistorySchema } from "@shared/types/sui-clmm";
import { createSuiClmmGrpc, decodeSuiGrpcWebUnary } from "../sui/grpc";
import { collectSuiClmmShadowQuotes } from "../sui/shadow";
import receipts from "./fixtures/sui-grpc-responses.json";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const headers = { "content-type": "application/grpc-web+proto" };
const signal = () => new AbortController().signal;
const encode = (value: string) => new TextEncoder().encode(value);
const binary = (base64: string) => Uint8Array.from(atob(base64), (byte) => byte.charCodeAt(0));
function frame(flag: number, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.length + 5);
  result[0] = flag; new DataView(result.buffer).setUint32(1, body.length); result.set(body, 5);
  return result;
}
function unary(payload: Uint8Array, trailer = "grpc-status: 0\r\n"): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([...frame(0, payload), ...frame(128, encode(trailer))]);
}
function budget(maxRequests = 64, timeoutMs = 45_000): DexRequestBudget {
  let used = 0;
  return { maxRequests, deadlineMs: Date.now() + timeoutMs, get remainingRequests() { return maxRequests - used; },
    tryConsume(count = 1) { if (count > maxRequests - used) return false; used += count; return true; } };
}
function client(options: { budget?: DexRequestBudget; onResponse?: () => void; signal?: AbortSignal } = {}) {
  return createSuiClmmGrpc({ url: "https://rpc.example.invalid", headers: { "X-Api-Key": "header-only-test-key" },
    signal: options.signal ?? signal(), budget: options.budget ?? budget(), onResponse: options.onResponse ?? vi.fn() });
}

describe("Sui binary gRPC-web live wire regression", () => {
  it("replays the actual collector through quote and diagnostic D1 persistence, including pruned ancestry", async () => {
    const { sample } = receipts;
    vi.spyOn(Date, "now").mockReturnValue(sample.observedAtSec * 1000);
    let index = 0;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const receipt = receipts.responses[index++];
      expect(new URL(String(url)).pathname).toBe(receipt.path);
      if (receipt.path !== "/graphql") {
        const sent = new Headers(init?.headers);
        expect(sent.get("X-Api-Key")).toBe("header-only-test-key");
        expect(sent.get("content-type")).toBe("application/grpc-web+proto");
        expect(sent.get("x-grpc-web")).toBe("1");
        expect(init?.redirect).toBe("manual");
      }
      return new Response(binary(receipt.bodyBase64), { status: receipt.status, headers: { "content-type": receipt.contentType! } });
    });
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [{ updated_at: sample.inputPriceReference.cacheUpdatedAtSec,
        value: JSON.stringify({ peggedAssets: [{ id: sample.stablecoinId, name: "Bucket", symbol: "BUCK", pegType: "peggedUSD",
          pegMechanism: "crypto-backed", price: sample.inputPriceUsd, priceSource: sample.inputPriceReference.source,
          priceConfidence: sample.inputPriceReference.confidence, priceObservedAt: sample.inputPriceReference.observedAtSec,
          priceObservedAtMode: "upstream", circulating: { peggedUSD: 1_000_000 }, chainCirculating: {}, chains: ["Sui"] }] }) }] },
      { match: "FROM cache WHERE key = ?", rows: [] },
      { match: "FROM dex_source_pagination_state", rows: [] },
      { match: "FROM dex_liquidity dl, json_each", rows: [{ pool_id: `sui:${sample.poolId}`, stablecoin_id: sample.stablecoinId, tvl_usd: 1_084_307, project: "cetus" }] },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
      { match: "INSERT INTO dex_source_pagination_state", rows: [], runMeta: { changes: 1 } },
    ]);
    const summary = await collectSuiClmmShadowQuotes({ db, env: { DWELLIR_API_KEY: "header-only-test-key" } });
    expect(summary).toMatchObject({ attempted: 1, persisted: 1, failed: 0, requests: 8, budgetExhausted: false,
      scoreEligible: false, independentCheckReason: "sui-grpc-inspection-unsupported" });
    expect(index).toBe(receipts.responses.length);
    expect(fetcher).toHaveBeenCalledTimes(8);
    const write = db.getHistory().find(({ sql }) => sql.includes("INSERT INTO cache"))!;
    const stored = SuiClmmShadowHistorySchema.parse(JSON.parse(String(write.binds[1]))).samples[0];
    expect(stored).toEqual(sample);
    expect(stored.quotes[2]).toMatchObject({ amountOut: null, reason: "sui-clmm-liquidity-exhausted", independentAgreement: null });
    expect(db.getHistory().some(({ sql }) => /INSERT INTO (dex_execution|dex_liquidity)/.test(sql))).toBe(false);
  });

  it("rejects transaction errors other than explicit NOT_FOUND rather than guessing ancestry", async () => {
    // BatchGetTransactionsResponse.transactions[0].error.code = INTERNAL.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from([10, 4, 18, 2, 8, 13])), { headers }));
    await expect(client()("sui_multiGetTransactionBlocks", [["digest"]])).rejects.toThrow("sui-grpc-transaction-read-failed");
  });

  it("keeps an explicit pruned transaction unavailable for the existing archive resolver", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from([10, 4, 18, 2, 8, 5])), { headers }));
    await expect(client()("sui_multiGetTransactionBlocks", [["digest"]])).resolves.toEqual([{ digest: "digest" }]);
  });

  it("names unsupported inspection before consuming a request or claiming agreement", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const requests = budget();
    await expect(client({ budget: requests })("sui_devInspectTransactionBlock", [])).rejects.toThrow("sui-grpc-inspection-unsupported");
    expect(requests.remainingRequests).toBe(64);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Sui gRPC-web framing and trust boundary", () => {
  it.each([
    { name: "missing trailer", body: frame(0, new Uint8Array()), reason: "missing-trailer" },
    { name: "truncated header", body: Uint8Array.from([0, 0]), reason: "invalid-frame" },
    { name: "truncated payload", body: Uint8Array.from([0, 0, 0, 0, 10]), reason: "truncated-frame" },
    { name: "compressed message", body: frame(1, new Uint8Array()), reason: "invalid-frame" },
    { name: "two messages", body: Uint8Array.from([...frame(0, new Uint8Array()), ...unary(new Uint8Array())]), reason: "invalid-frame" },
    { name: "duplicate status", body: unary(new Uint8Array(), "grpc-status: 0\r\ngrpc-status: 0\r\n"), reason: "invalid-trailer" },
    { name: "malformed status", body: unary(new Uint8Array(), "grpc-status: nope\r\n"), reason: "invalid-trailer" },
    { name: "error status", body: frame(128, encode("grpc-status: 13\r\ngrpc-message: secret upstream details\r\n")), reason: "status-13" },
    { name: "message missing", body: frame(128, encode("grpc-status: 0\r\n")), reason: "missing-message" },
    { name: "bytes after trailer", body: Uint8Array.from([...unary(new Uint8Array()), 0]), reason: "invalid-frame" },
  ])("rejects $name", ({ body, reason }) => {
    expect(() => decodeSuiGrpcWebUnary(body)).toThrow(`sui-grpc-${reason}`);
  });

  it.each([
    [10, 255, 255, 255, 255, 127], // Claimed nested-message length exceeds intake.
    [0], // Invalid field zero.
    [8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2], // uint64 overflow.
  ])("rejects malformed protobuf (%j)", async (...payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(unary(Uint8Array.from(payload)), { headers }));
    await expect(client()("sui_getObject", ["0x1"])).rejects.toThrow(/^sui-grpc-/);
  });
});

describe("Sui gRPC shared request/credit and connection limits", () => {
  it("consumes an HTTP failure once, meters its response and refuses an unbudgeted retry", async () => {
    const response = new Response("upstream details", { status: 404 });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const requests = budget(1);
    const rpc = client({ onResponse, budget: requests });
    await expect(rpc("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-http-404");
    await expect(rpc("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    expect(response.bodyUsed).toBe(true);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires the binary gRPC-web content type", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not protobuf", { headers: { "content-type": "application/json" } }));
    await expect(client()("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-content-type-mismatch");
  });

  it("cancels and meters oversized bodies without retrying", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { ...headers, "content-length": String(2 * 1024 * 1024 + 1) } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    await expect(client({ onResponse })("sui_getObject", ["0x1"])).rejects.toThrow("sui-grpc-transport-failed");
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active through body consumption and rejects a concurrent read", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const onResponse = vi.fn();
    const rpc = client({ budget: budget(2, 20), onResponse });
    const pending = rpc("sui_getObject", ["0x1"]).catch((error: unknown) => error);
    await expect(rpc("sui_getObject", ["0x2"])).rejects.toThrow("sui-rpc-concurrent-request");
    await vi.advanceTimersByTimeAsync(21);
    await expect(pending).resolves.toMatchObject({ message: "sui-grpc-transport-failed" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("does not start a request after cancellation or deadline", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController(); controller.abort();
    await expect(client({ signal: controller.signal })("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    await expect(client({ budget: budget(2, -1) })("sui_getObject", ["0x1"])).rejects.toThrow("sui-rpc-budget-exhausted");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
