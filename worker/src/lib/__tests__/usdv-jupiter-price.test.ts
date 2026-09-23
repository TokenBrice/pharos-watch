import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import accountFixture from "./fixtures/usdv-jupiter-accounts.json";
import quoteFixture from "./fixtures/usdv-jupiter-quotes.json";
import { fetchUsdvJupiterPrice, validateUsdvPoolState } from "../authoritative-price-sources/usdv-jupiter";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { applyProtocolPriceOverrides, createValidationContextResolver } from "../../cron/sync-stablecoins/pricing";
const fetchJson = vi.fn();
vi.mock("../fetch-retry", () => ({ fetchJsonWithRetry: (...args: unknown[]) => fetchJson(...args) }));
const NOW = 1790102400;
const context = () => ({ lastRejectionReason: null as string | null, assetsById: new Map([["usdc-circle", { id: "usdc-circle", price: 1, priceSource: "coingecko", priceConfidence: "single-source", priceObservedAt: NOW - 20, priceObservedAtMode: "upstream" } as PeggedAsset]]) });
function state() { return structuredClone(accountFixture.result); }
function mutate(index: number, offset: number, value: number) {
  const result = state(); const data = Buffer.from(result.value[index].data[0], "base64"); data[offset] = value;
  result.value[index].data[0] = data.toString("base64"); return result;
}
function laggingState() { const s = state(); s.context.slot -= 45; return s; }
function setup(options: { pool?: unknown; timestamp?: number | null; quoteChange?: (q: (typeof quoteFixture)[number]) => void; stateBody?: (read: number) => unknown } = {}) {
  let reads = 0;
  fetchJson.mockImplementation(async (url: string, init: RequestInit) => {
    let body: unknown;
    if (url.includes("jup.ag")) {
      const depth = new URL(url).searchParams.get("amount") === "1000000000000";
      const q = structuredClone(quoteFixture[depth ? 1 : 0]); q.contextSlot = state().context.slot - 30;
      q.routePlan[0].swapInfo.updateContextSlot = String(state().context.slot - 60); options.quoteChange?.(q); body = q;
    } else {
      const request = JSON.parse(init.body as string);
      if (request.method === "getMultipleAccounts") {
        reads += 1;
        body = options.stateBody ? options.stateBody(reads) : { result: options.pool ?? state() };
      } else {
        body = { result: options.timestamp === undefined ? NOW - 30 : options.timestamp };
      }
    }
    return { response: { ok: true }, body };
  });
  return () => reads;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); setup(); });
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe("reviewed USDv direct Jupiter route", () => {
  it("validates independently captured pool and active bin state", () => {
    expect(validateUsdvPoolState(state() as never)).toMatchObject({ activeOutput: 76318595787n });
  });
  it("admits a fresh exact sell quote with oldest dependency provenance", async () => {
    expect(await fetchUsdvJupiterPrice(context())).toEqual({ price: .998882, source: "jupiter-exact", confidence: "fallback", observedAt: NOW - 30, observedAtMode: "upstream" });
  });
  it("recovers a lagging confirmed-state read once a rotated retry catches up", async () => {
    const reads = setup({ stateBody: (read) => (read > 2 ? { result: state() } : { result: laggingState() }) });
    const promise = fetchUsdvJupiterPrice(context());
    await vi.runAllTimersAsync();
    expect(reads()).toBe(3);
    expect(await promise).toEqual({ price: .998882, source: "jupiter-exact", confidence: "fallback", observedAt: NOW - 30, observedAtMode: "upstream" });
  });
  it("treats an RPC min-context-slot error as retryable endpoint lag", async () => {
    const reads = setup({ stateBody: (read) => (read <= 2 ? { error: { code: -32010 } } : { result: state() }) });
    const promise = fetchUsdvJupiterPrice(context());
    await vi.runAllTimersAsync();
    expect(reads()).toBe(3);
    expect(await promise).toEqual({ price: .998882, source: "jupiter-exact", confidence: "fallback", observedAt: NOW - 30, observedAtMode: "upstream" });
  });
  it("still rejects pool-state when every bounded catch-up attempt stays behind the quotes", async () => {
    const ctx = context();
    const reads = setup({ stateBody: () => ({ result: laggingState() }) });
    const promise = fetchUsdvJupiterPrice(ctx);
    await vi.runAllTimersAsync();
    expect(await promise).toBeNull();
    expect(reads()).toBe(6);
    expect(ctx.lastRejectionReason).toBe("jupiter-exact:pool-state");
  });
  it("does not retry the state read once the candidate deadline aborts", async () => {
    const controller = new AbortController();
    const reads = setup({ stateBody: () => ({ result: laggingState() }) });
    const promise = fetchUsdvJupiterPrice(context(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await promise.then(() => "resolved", () => "rejected")).toBe("rejected");
    expect(reads()).toBe(2);
  });
  it.each([[0,82,1],[0,75,0],[0,816,1],[0,880,1],[0,88,0],[1,24,0],[1,16,0],[2,108,2],[3,108,2],[4,44,6],[5,45,0]])("rejects disabled, unreviewed, wrong-identity or frozen state %s %s", async (i,offset,value) => {
    setup({ pool: mutate(i,offset,value) }); expect(await fetchUsdvJupiterPrice(context())).toBeNull();
  });
  it.each([NOW-300, NOW+1, null])("rejects stale, future or missing slot timestamp %s", async (timestamp) => {
    setup({timestamp}); expect(await fetchUsdvJupiterPrice(context())).toBeNull();
  });
  it("rejects an API quote from another pool", async () => {
    setup({quoteChange: (q) => { q.routePlan[0].swapInfo.ammKey = "other"; }}); expect(await fetchUsdvJupiterPrice(context())).toBeNull();
  });
  it("rejects malformed quotes and inadequate active-bin output inventory", async () => {
    setup({ quoteChange: (q) => { q.outAmount = "NaN"; }}); expect(await fetchUsdvJupiterPrice(context())).toBeNull();
    const s = state(), b = Buffer.from(s.value[1].data[0], "base64"); b.writeBigUInt64LE(0n,56+39*144+8); s.value[1].data[0]=b.toString("base64");
    setup({pool:s}); expect(await fetchUsdvJupiterPrice(context())).toBeNull();
  });
  it("retains the soft-source severe downside publication guard", () => {
    const run = (price: number) => applyProtocolPriceOverrides({ assets: [{id:"usdv-solomon",symbol:"USDv",price:null,pegType:"peggedUSD"} as unknown as PeggedAsset], overrides:new Map([["usdv-solomon",{price,source:"jupiter-exact",confidence:"fallback" as const,observedAt:NOW-30,observedAtMode:"upstream" as const}]]),validationContexts:createValidationContextResolver(),syncStartSec:NOW});
    expect(run(.998882)).toBe(1); expect(run(.2)).toBe(0);
  });
});
