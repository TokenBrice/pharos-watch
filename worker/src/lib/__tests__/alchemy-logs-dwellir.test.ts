import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAlchemyLogs, getAlchemyTransactionContextBatchMany, resolveBlockTimestamps } from "../alchemy-logs";
import { registerRpcAuth, type RpcEndpoint } from "../chain-registry";
import { createBudget } from "../evm-logs";
import * as credits from "../rpc-provider-budget";

const endpoint: RpcEndpoint = { url: "https://logs-test.dwellir.com", operator: "dwellir", keyed: true,
  position: "registry", stateHistory: "archive", logsHistory: "full", maxLogBlockSpan: 10_000 };
const response = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
const error = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }));

describe("Dwellir raw log transport", () => {
  beforeEach(() => { registerRpcAuth("dwellir", endpoint.url, { "X-Api-Key": "test-key" }); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("clamps inclusive pages and meters/authenticates every physical request", async () => {
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response([])));
    vi.stubGlobal("fetch", fetcher);
    const result = await fetchAlchemyLogs(endpoint.url, "0xabc", [], 1, 20_001, createBudget(20), undefined, { endpoint });
    expect(result).toMatchObject({ complete: true, scannedToBlock: 20_001, calls: 3 });
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).params[0])).toEqual([
      { address: "0xabc", topics: [], fromBlock: "0x1", toBlock: "0x2710" },
      { address: "0xabc", topics: [], fromBlock: "0x2711", toBlock: "0x4e20" },
      { address: "0xabc", topics: [], fromBlock: "0x4e21", toBlock: "0x4e21" },
    ]);
    expect(meter.mock.calls).toEqual([[1], [1], [1]]);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Api-Key")).toBe("test-key");
  });

  it.each([-32005, -32000])("splits HTTP-200 %s range failures sequentially", async (code) => {
    const fetcher = vi.fn().mockResolvedValueOnce(error(code, "block range limit exceeded"))
      .mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchAlchemyLogs(endpoint.url, "0xabc", [], 1, 100, createBudget(20), undefined, { endpoint }))
      .toMatchObject({ complete: true, scannedToBlock: 100, calls: 3 });
  });

  it("does not advance the proven frontier over a failed page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(error(-32602, "invalid filter")));
    expect(await fetchAlchemyLogs(endpoint.url, "0xabc", [], 1, 20_000, createBudget(20), undefined, { endpoint }))
      .toMatchObject({ complete: false, scannedToBlock: 10_000 });
  });

  it("rejects retained history before issuing requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(response(null));
    vi.stubGlobal("fetch", fetcher);
    const retained = { ...endpoint, logsHistory: { retainedBlocks: 100 } };
    expect(await fetchAlchemyLogs(endpoint.url, "0xabc", [], 899, 950, createBudget(20), undefined,
      { endpoint: retained, headBlock: 1000 })).toMatchObject({ complete: false, scannedToBlock: 898, calls: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("meters receipt batch members individually", async () => {
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
    await getAlchemyTransactionContextBatchMany(endpoint.url, ["0xa", "0xb"], createBudget(20));
    expect(meter).toHaveBeenCalledWith(4);
  });

  it("retries every unexecuted receipt-context member singly and meters the retries", async () => {
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const tx = { hash: "0xa", to: null, input: "0x" };
    const receipt = { transactionHash: "0xa", to: null, logs: [] };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([0, 1].map((id) => ({
      id, error: { code: -32000, message: "batch not executed: member 1 (eth_getLogs) violated the log range policy" },
    }))))).mockResolvedValueOnce(response(tx)).mockResolvedValueOnce(response(receipt));
    vi.stubGlobal("fetch", fetcher);
    const budget = createBudget(20);
    expect((await getAlchemyTransactionContextBatchMany(endpoint.url, ["0xa"], budget)).get("0xa"))
      .toEqual({ tx, receipt });
    expect(budget.count).toBe(3);
    expect(meter.mock.calls).toEqual([[2], [1], [1]]);
    expect(fetcher.mock.calls.slice(1).every((call) => !Array.isArray(JSON.parse(call[1].body)))).toBe(true);
  });

  it("caps unexecuted member retries at eight and leaves excess contexts unavailable", async () => {
    const txHashes = Array.from({ length: 6 }, (_, index) => `0x${index}`);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(
      Array.from({ length: 12 }, (_, id) => ({ id, error: { code: -32000, message: "batch not executed" } })),
    ))).mockImplementation(() => Promise.resolve(response(null)));
    vi.stubGlobal("fetch", fetcher);
    const budget = createBudget(100);
    const result = await getAlchemyTransactionContextBatchMany(endpoint.url, txHashes, budget);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(budget.count).toBe(9);
    expect([...result.values()]).toEqual(txHashes.map(() => ({ tx: null, receipt: null })));
  });

  it("stops member retries when the caller deadline expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(
      [0, 1].map((id) => ({ id, error: { code: -32000, message: "batch not executed" } })),
    ))).mockImplementation(() => {
      clock.mockReturnValue(2000);
      return Promise.resolve(response({ hash: "0xa", to: null, input: "0x" }));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await getAlchemyTransactionContextBatchMany(endpoint.url, ["0xa"], createBudget(100), undefined, 30_000, 2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.get("0xa")?.receipt).toBeNull();
  });

  it("honors abort before another member retry", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(
      [0, 1].map((id) => ({ id, error: { code: -32000, message: "batch not executed" } })),
    ))).mockImplementation(() => {
      controller.abort();
      return Promise.resolve(response(null));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(getAlchemyTransactionContextBatchMany(endpoint.url, ["0xa"], createBudget(100), controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an error without a message", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 0, error: { code: -32000 } }])));
    vi.stubGlobal("fetch", fetcher);
    expect((await getAlchemyTransactionContextBatchMany(endpoint.url, ["0xa"], createBudget(20))).get("0xa"))
      .toEqual({ tx: null, receipt: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries unexecuted timestamp batch members rather than accepting error rows", async () => {
    const meter = vi.spyOn(credits, "recordDwellirCredits");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 0, error: { code: -32000, message: "batch not executed: member 1 (eth_getLogs) violated the log range policy" } },
    ]))).mockResolvedValueOnce(new Response(JSON.stringify([{ id: 0, result: { timestamp: "0x64" } }])));
    vi.stubGlobal("fetch", fetcher);
    const result = await resolveBlockTimestamps(endpoint.url, [10], createBudget(20));
    expect(result.get(10)).toBe(100);
    expect(meter.mock.calls).toEqual([[1], [1]]);
  });
});
