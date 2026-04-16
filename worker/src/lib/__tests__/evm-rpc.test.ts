import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

vi.mock("../chain-registry", () => ({
  getChainRpc: () => null,
}));

const {
  fetchEtherscanProxyHex,
  fetchEtherscanUint256AtBlock,
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmUint256AtBlock,
  parseUint256Hex,
  resolveClosestBlockAtOrBeforeTimestamp,
} = await import("../evm-rpc");

describe("evm-rpc helpers", () => {
  afterEach(() => {
    fetchWithRetryMock.mockReset();
  });

  it("parses uint256 hex values safely", () => {
    expect(parseUint256Hex("0x64")).toBe(100n);
    expect(parseUint256Hex("0x")).toBeNull();
    expect(parseUint256Hex("not-hex")).toBeNull();
  });

  it("fetches uint256 values from extra RPC URLs", async () => {
    fetchWithRetryMock.mockImplementation(async (url: string) => {
      if (url === "https://rpc.example") {
        return new Response(JSON.stringify({ result: "0x64" }), { status: 200 });
      }
      return null;
    });

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    });

    expect(result).toBe(100n);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a later RPC URL when the first one fails", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0xc8" }), { status: 200 }));

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe(200n);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("fetches raw hex call results from RPC URLs", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }),
    );

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    });

    expect(result).toBe("0x2a");
  });

  it("falls back when first eth_call result is empty hex", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe("0x2a");
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("includes gas in eth_call request body when provided", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }),
    );

    await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
      gas: "0x7a120",
    });

    const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      params: Array<{ to: string; data: string; gas?: string }>;
    };
    expect(body.params[0]).toMatchObject({ to: "0xToken", data: "0x1234", gas: "0x7a120" });
  });

  it("normalizes gas as a JSON-RPC quantity before sending eth_call", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }),
    );

    await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
      gas: "0x0F4240",
    });

    const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      params: Array<{ gas?: string }>;
    };
    expect(body.params[0]?.gas).toBe("0xF4240");
  });

  it("falls back when eth_call returns an invalid hex result", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "not-hex" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe("0x2a");
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when eth_call returns only invalid results", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "not-hex" }), { status: 200 }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 1 RPCs"));
    warnSpy.mockRestore();
  });

  it("fetches block numbers and timestamps through the shared RPC path", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x10" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x64" } }), { status: 200 }));

    const blockNumber = await fetchEvmBlockNumber("ethereum", { extraRpcUrls: ["https://rpc.example"] });
    const blockTimestamp = await fetchEvmBlockTimestamp("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] });

    expect(blockNumber).toBe(16);
    expect(blockTimestamp).toBe(100);
  });

  it("resolves the closest block at or before a target timestamp", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x3b6" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x398" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x38e" } }), { status: 200 }));

    const block = await resolveClosestBlockAtOrBeforeTimestamp(
      "ethereum",
      900,
      {
        latestBlockNumber: 100,
        blockTimestampByNumber: new Map([
          [100, 1000],
          [90, 900],
        ]),
      },
      { extraRpcUrls: ["https://rpc.example"] },
    );

    expect(block).toBe(90);
  });

  it("fetches proxy hex results from Etherscan", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), {
        status: 200,
      }),
    );

    const result = await fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_getStorageAt",
      address: "0xProxy",
      position: "0xSlot",
      apiKey: "etherscan-key",
    });

    expect(result).toBe("0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("converts Etherscan proxy hex results to uint256", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "0x12c" }), { status: 200 }),
    );

    const result = await fetchEtherscanUint256AtBlock(1, "0xToken", "0x18160ddd", "latest", {
      apiKey: "etherscan-key",
    });

    expect(result).toBe(300n);
  });

  it("logs summary when all RPCs fail for fetchEvmCallHexAtBlock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: -32000, message: "nope" } }), { status: 200 }));

    const result = await fetchEvmCallHexAtBlock(undefined, "0xToken", "0x1234", "latest", {
      extraRpcUrls: ["https://rpc.a", "https://rpc.b"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 2 RPCs"));
    warnSpy.mockRestore();
  });

  it("logs summary when all RPCs throw for fetchEvmUint256AtBlock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockRejectedValue(new Error("network error"));

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.a"],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[evm-rpc] eth_call failed across 1 RPCs"));
    warnSpy.mockRestore();
  });

  it("returns null on malformed Etherscan payloads", async () => {
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: "not-hex" }), { status: 200 }),
    );

    const result = await fetchEtherscanProxyHex({
      evmChainId: 1,
      action: "eth_call",
      to: "0xToken",
      data: "0x18160ddd",
      apiKey: "etherscan-key",
    });

    expect(result).toBeNull();
  });
});
