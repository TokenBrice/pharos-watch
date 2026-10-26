import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNobleSupply } from "../noble-supply";

const read = () => fetchNobleSupply("ausdy", 18, new AbortController().signal);
const block = (age = 0) => ({ height: "123", timestamp: new Date(Date.now() - age * 1000).toISOString() });
const supplyFetcher = (body: unknown) => vi.fn().mockResolvedValueOnce(Response.json(block())).mockResolvedValueOnce(Response.json(body));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Noble bank supply", () => {
  it.each(["62531369928814821270000", "0"])("reads exact native bank stock %s", async (amount) => {
    const fetcher = supplyFetcher({ amount: { denom: "ausdy", amount } });
    vi.stubGlobal("fetch", fetcher);
    expect(await read()).toBe(BigInt(amount));
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      "https://noble-api.polkachu.com/cosmos/base/node/v1beta1/status",
      "https://noble-api.polkachu.com/cosmos/bank/v1beta1/supply/by_denom?denom=ausdy",
    ]);
  });
  it.each([600, -60])("admits the block freshness boundary %ss", async age => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(block(age)))
      .mockResolvedValueOnce(Response.json({ amount: { denom: "ausdy", amount: "1" } })));
    expect(await read()).toBe(1n);
  });
  it.each([601, -61])("rejects a stale or future block (%ss) before reading supply", async age => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(block(age))); vi.stubGlobal("fetch", fetcher);
    await expect(read()).rejects.toThrow("noble-block-stale-or-future");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { height: "123" }, { ...block(), height: "0" }, { ...block(), timestamp: "invalid" }])("rejects missing or malformed block clocks", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(body)));
    await expect(read()).rejects.toThrow();
  });
  it("fails closed on a block endpoint error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 })));
    await expect(read()).rejects.toThrow();
  });
  it.each([null, {}, { amount: { denom: "other", amount: "1" } },
    ...[undefined, "", "-1", "1.5", "1e6", "9".repeat(79)].map((amount) => ({ amount: { denom: "ausdy", amount } }))])(
    "rejects missing, malformed or mismatched stock", async (body) => {
      vi.stubGlobal("fetch", supplyFetcher(body));
      await expect(read()).rejects.toThrow();
    },
  );
  it("rejects oversized and invalid-JSON bodies", async () => {
    for (const clock of [true, false]) {
      for (const body of [" ".repeat(16 * 1024 + 1), "{"]) {
        const fetcher = vi.fn();
        if (!clock) fetcher.mockResolvedValueOnce(Response.json(block()));
        fetcher.mockResolvedValueOnce(new Response(body)); vi.stubGlobal("fetch", fetcher);
        await expect(read()).rejects.toThrow();
      }
    }
  });
  it.each([true, false])("times out a stalled body (block: %s)", async clock => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    if (!clock) fetcher.mockResolvedValueOnce(Response.json(block()));
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }))); vi.stubGlobal("fetch", fetcher);
    const rejected = expect(read()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
  });
  it("rejects unreviewed identities and cancelled reads", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchNobleSupply("usdy", 18, new AbortController().signal)).rejects.toThrow("identity");
    await expect(fetchNobleSupply("ausdy", 6, new AbortController().signal)).rejects.toThrow("identity");
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(fetchNobleSupply("ausdy", 18, controller.signal)).rejects.toThrow("cancelled");
  });
});
