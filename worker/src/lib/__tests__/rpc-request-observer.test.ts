import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJsonRpcAtUrl } from "../evm-rpc";
import { getRpcRequestObserver, withRpcRequestObserver } from "../rpc-request-observer";

const payload = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };

afterEach(() => vi.unstubAllGlobals());

describe("RPC request observation", () => {
  it("isolates concurrent invocation observers and clears scope after settlement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1, result: "0x1" }))));
    const first = { beforeRequest: vi.fn(() => true), onOutcome: vi.fn() };
    const second = { beforeRequest: vi.fn(() => true), onOutcome: vi.fn() };
    await Promise.all([
      withRpcRequestObserver(first, () => requestJsonRpcAtUrl("https://first.example.test", payload, {})),
      withRpcRequestObserver(second, () => requestJsonRpcAtUrl("https://second.example.test", payload, {})),
    ]);
    expect(first.onOutcome).toHaveBeenCalledExactlyOnceWith("https://first.example.test", expect.objectContaining({ status: "response" }));
    expect(second.onOutcome).toHaveBeenCalledExactlyOnceWith("https://second.example.test", expect.objectContaining({ status: "response" }));
    expect(getRpcRequestObserver()).toBeUndefined();
    await requestJsonRpcAtUrl("https://outside.example.test", payload, {});
    expect(first.onOutcome).toHaveBeenCalledTimes(1);
    expect(second.onOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not bill or record requests blocked before admission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const observer = { beforeRequest: vi.fn(() => false), onOutcome: vi.fn() };
    const meter = vi.fn(() => true);
    const result = await withRpcRequestObserver(observer, () =>
      requestJsonRpcAtUrl("https://blocked.example.test", payload, { beforeRequest: meter }));
    expect(result.status).toBe("control-error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
    expect(observer.onOutcome).not.toHaveBeenCalled();
  });

  it("does not attribute caller cancellation to a provider", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort(new Error("caller stopped"));
      throw controller.signal.reason;
    }));
    const observer = { beforeRequest: vi.fn(() => true), onOutcome: vi.fn() };
    const result = await withRpcRequestObserver(observer, () => requestJsonRpcAtUrl(
      "https://cancelled.example.test", payload, { signal: controller.signal },
    ));
    expect(result.status).toBe("control-error");
    expect(observer.onOutcome).not.toHaveBeenCalled();
    expect(getRpcRequestObserver()).toBeUndefined();
  });
});
