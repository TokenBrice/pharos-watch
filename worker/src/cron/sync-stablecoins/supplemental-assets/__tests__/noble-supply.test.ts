import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNobleSupply } from "../noble-supply";

const read = () => fetchNobleSupply("ausdy", 18, new AbortController().signal);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Noble bank supply", () => {
  it.each(["62531369928814821270000", "0"])("reads exact native bank stock %s", async (amount) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ amount: { denom: "ausdy", amount } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await read()).toBe(BigInt(amount));
    expect(fetcher.mock.calls[0][0]).toBe("https://noble-api.polkachu.com/cosmos/bank/v1beta1/supply/by_denom?denom=ausdy");
  });
  it.each([null, {}, { amount: { denom: "other", amount: "1" } },
    ...[undefined, "", "-1", "1.5", "1e6", "9".repeat(79)].map((amount) => ({ amount: { denom: "ausdy", amount } }))])(
    "rejects missing, malformed or mismatched stock", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(read()).rejects.toThrow();
    },
  );
  it("rejects oversized and invalid-JSON bodies", async () => {
    for (const body of [" ".repeat(16 * 1024 + 1), "{"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(read()).rejects.toThrow();
    }
  });
  it("times out a stalled body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))));
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
