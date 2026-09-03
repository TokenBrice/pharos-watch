import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithRetryMock = vi.fn();

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: async (...args: unknown[]) => {
    const result = await fetchWithRetryMock(...args);
    if (result instanceof Response) {
      return { response: result, body: await result.clone().json() };
    }
    return result;
  },
}));

vi.mock("../chain-registry", () => ({
  getChainRpc: () => null,
  getAlchemyAuthHeaders: () => undefined,
}));

const {
  MULTICALL3_ADDRESS,
  encodeMulticall3Aggregate3CallData,
  fetchEvmRpcBatch,
  fetchEvmRpcBatchDetailed,
  fetchEvmMulticall3Aggregate3AtBlock,
  fetchEvmBlockHeader,
  fetchEvmBlockHeaderAtTag,
  fetchEtherscanProxyHex,
  fetchEtherscanUint256AtBlock,
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmUint256AtBlock,
  parseUint256Hex,
  resolveClosestBlockAtOrBeforeTimestamp,
} = await import("../evm-rpc");

function word(value: bigint | number): string {
  const bigintValue = typeof value === "bigint" ? value : BigInt(value);
  return bigintValue.toString(16).padStart(64, "0");
}

function encodeBytes(value: string): string {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const paddedByteLength = Math.ceil(body.length / 2 / 32) * 32;
  return `${word(body.length / 2)}${body.padEnd(paddedByteLength * 2, "0")}`;
}

function encodeAggregate3Return(results: Array<{ success: boolean; returnData: string }>): `0x${string}` {
  const encodedResults = results.map(
    (result) => `${word(result.success ? 1 : 0)}${word(64)}${encodeBytes(result.returnData)}`,
  );
  let nextOffset = results.length * 32;
  const offsets = encodedResults.map((encodedResult) => {
    const offset = word(nextOffset);
    nextOffset += encodedResult.length / 2;
    return offset;
  });
  return `0x${word(32)}${word(results.length)}${offsets.join("")}${encodedResults.join("")}` as `0x${string}`;
}

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0xc8" }), { status: 200 }));

    const result = await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
    });

    expect(result).toBe(200n);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ retryMode: "network-only" }));
  });

  it("falls back when an RPC returns a null result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ result: null }), { status: 200 }),
    );

    await expect(
      fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("null result"));
    warnSpy.mockRestore();
  });

  it("caps each fallback request to the remaining absolute deadline", async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs += 400;
      return null;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ timeoutMs: 1_000 }));
    expect(fetchWithRetryMock.mock.calls[1]?.[3]).toEqual(expect.objectContaining({ timeoutMs: 600 }));
    nowSpy.mockRestore();
  });

  it("does not start a fallback RPC after the absolute deadline", async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchWithRetryMock.mockImplementation(async () => {
      nowMs = 2_001;
      return null;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      timeoutMs: 10_000,
      deadlineMs: 2_000,
      maxRetries: 0,
    });

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("charges the request guard separately for primary and fallback URL attempts", async () => {
    fetchWithRetryMock.mockResolvedValue(null);
    let attemptsRemaining = 1;
    const beforeRequest = vi.fn(() => {
      if (attemptsRemaining <= 0) return false;
      attemptsRemaining -= 1;
      return true;
    });

    await fetchEvmUint256AtBlock(undefined, "0xToken", "0x18160ddd", "latest", {
      extraRpcUrls: ["https://rpc.primary", "https://rpc.fallback"],
      maxRetries: 0,
      beforeRequest,
    });

    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it("encodes Multicall3 aggregate3 calldata", () => {
    expect(
      encodeMulticall3Aggregate3CallData([
        {
          label: "balance",
          target: "0x1111111111111111111111111111111111111111",
          callData: "0x12345678",
        },
      ]),
    ).toBe(
      "0x82ad56cb" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000001111111111111111111111111111111111111111" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000060" +
        "0000000000000000000000000000000000000000000000000000000000000004" +
        "1234567800000000000000000000000000000000000000000000000000000000",
    );
  });

  it("returns JSON-RPC batch results in request order", async () => {
    const controller = new AbortController();
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 2, result: "second" },
          { jsonrpc: "2.0", id: 1, result: "first" },
        ]),
        { status: 200 },
      ),
    );
    const calls = [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getCode", params: ["0xToken", "safe"] },
    ];

    await expect(
      fetchEvmRpcBatch("gnosis", calls, {
        extraRpcUrls: ["https://rpc.example"],
        signal: controller.signal,
        timeoutMs: 1_234,
        maxRetries: 0,
      }),
    ).resolves.toEqual(["first", "second"]);

    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      "https://rpc.example",
      expect.objectContaining({ method: "POST", signal: controller.signal }),
      0,
      { timeoutMs: 1_234, retryMode: "network-only" },
    );
    const body = JSON.parse(String(fetchWithRetryMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: ["0xToken", "safe"] },
    ]);
  });

  it("fails closed when JSON-RPC batch responses are malformed or error", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([null, { jsonrpc: "2.0", id: 2, result: "second" }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "first" },
            { jsonrpc: "2.0", id: 2, error: { code: -32_000, message: "failure" } },
          ]),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(
      fetchEvmRpcBatch(
        "gnosis",
        [{ method: "eth_blockNumber", params: [] }, { method: "eth_chainId", params: [] }],
        {
          extraRpcUrls: [
            "https://rpc.malformed",
            "https://rpc.error-envelope",
            "https://rpc.unavailable",
          ],
          maxRetries: 0,
        },
      ),
    ).resolves.toBeNull();
  });

  it("preserves per-call errors in detailed JSON-RPC batches", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted" } },
          { jsonrpc: "2.0", id: 1, result: "0x2a" },
        ]),
        { status: 200 },
      ),
    );

    await expect(
      fetchEvmRpcBatchDetailed(
        "rootstock",
        [{ method: "eth_call", params: ["first"] }, { method: "eth_call", params: ["second"] }],
        { extraRpcUrls: ["https://rpc.example"] },
      ),
    ).resolves.toEqual({
      results: ["0x2a", undefined],
      errors: [{ index: 1, code: 3, message: "execution reverted" }],
    });
  });

  it("fails closed across malformed detailed JSON-RPC batch fallbacks", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([null, { jsonrpc: "2.0", id: 2, result: "second" }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "first" },
            { jsonrpc: "2.0", id: 1, result: "duplicate" },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, result: "first" },
            { jsonrpc: "2.0", id: 2 },
          ]),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(
      fetchEvmRpcBatchDetailed(
        "rootstock",
        [{ method: "eth_call", params: ["first"] }, { method: "eth_call", params: ["second"] }],
        {
          extraRpcUrls: [
            "https://rpc.malformed",
            "https://rpc.duplicate",
            "https://rpc.missing-result",
            "https://rpc.unavailable",
          ],
          maxRetries: 0,
        },
      ),
    ).resolves.toBeNull();
  });

  it("decodes Multicall3 aggregate3 partial failures from the canonical contract", async () => {
    const calls = [
      {
        label: "supply",
        target: "0x1111111111111111111111111111111111111111",
        callData: "0x18160ddd",
      },
      {
        label: "optional-paused",
        target: "0x2222222222222222222222222222222222222222",
        callData: "0x5c975abb",
        allowFailure: true,
      },
    ];
    const successReturnData = `0x${word(42)}`;
    fetchWithRetryMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: encodeAggregate3Return([
            { success: true, returnData: successReturnData },
            { success: false, returnData: "0x" },
          ]),
        }),
        { status: 200 },
      ),
    );
    const controller = new AbortController();

    const result = await fetchEvmMulticall3Aggregate3AtBlock("ethereum", calls, "latest", {
      extraRpcUrls: ["https://rpc.example"],
      signal: controller.signal,
      timeoutMs: 1234,
    });

    expect(result).toEqual([
      { label: "supply", success: true, returnData: successReturnData },
      { label: "optional-paused", success: false, returnData: "0x" },
    ]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock.mock.calls[0][0]).toBe("https://rpc.example");
    expect(fetchWithRetryMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(fetchWithRetryMock.mock.calls[0][3]).toEqual({ timeoutMs: 1234, retryMode: "network-only" });

    const body = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      method: string;
      params: Array<{ to: string; data: string } | string>;
    };
    expect(body.method).toBe("eth_call");
    expect(body.params[0]).toMatchObject({
      to: MULTICALL3_ADDRESS,
      data: encodeMulticall3Aggregate3CallData(calls),
    });
    expect(body.params[1]).toBe("latest");
  });

  it("chunks Multicall3 aggregate3 requests when a batch size is configured", async () => {
    const calls = [
      {
        label: "first",
        target: "0x1111111111111111111111111111111111111111",
        callData: "0x11111111",
      },
      {
        label: "second",
        target: "0x2222222222222222222222222222222222222222",
        callData: "0x22222222",
      },
      {
        label: "third",
        target: "0x3333333333333333333333333333333333333333",
        callData: "0x33333333",
      },
    ];
    const firstReturnData = `0x${word(1)}`;
    const secondReturnData = `0x${word(2)}`;
    const thirdReturnData = `0x${word(3)}`;
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: encodeAggregate3Return([
              { success: true, returnData: firstReturnData },
              { success: true, returnData: secondReturnData },
            ]),
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: encodeAggregate3Return([{ success: true, returnData: thirdReturnData }]),
          }),
          { status: 200 },
        ),
      );

    const result = await fetchEvmMulticall3Aggregate3AtBlock("ethereum", calls, "latest", {
      extraRpcUrls: ["https://rpc.example"],
      multicallBatchSize: 2,
    });

    expect(result).toEqual([
      { label: "first", success: true, returnData: firstReturnData },
      { label: "second", success: true, returnData: secondReturnData },
      { label: "third", success: true, returnData: thirdReturnData },
    ]);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(fetchWithRetryMock.mock.calls[0][1]?.body) as {
      params: Array<{ data: string } | string>;
    };
    const secondBody = JSON.parse(fetchWithRetryMock.mock.calls[1][1]?.body) as {
      params: Array<{ data: string } | string>;
    };
    expect(firstBody.params[0]).toMatchObject({
      data: encodeMulticall3Aggregate3CallData(calls.slice(0, 2)),
    });
    expect(secondBody.params[0]).toMatchObject({
      data: encodeMulticall3Aggregate3CallData(calls.slice(2)),
    });
  });

  it("fetches raw hex call results from RPC URLs", async () => {
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }));

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
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }));

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
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "0x2a" }), { status: 200 }));

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

  it("distinguishes absent bytecode from an unavailable code request", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x" }), { status: 200 }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: "0x6000" }), { status: 200 }));

    await expect(fetchEvmCodeStatusAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toEqual({ status: "absent" });
    await expect(fetchEvmCodeStatusAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toEqual({ status: "unavailable" });
    await expect(fetchEvmCodeAtBlock(undefined, "0xPool", "latest", {
      extraRpcUrls: ["https://rpc.example"],
    })).resolves.toBe("0x6000");
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

  it("requires a numbered block header with its canonical hash", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              number: "0x10",
              timestamp: "0x64",
              hash: `0x${"A".repeat(64)}`,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              number: "0x11",
              timestamp: "0x64",
              hash: `0x${"b".repeat(64)}`,
            },
          }),
          { status: 200 },
        ),
      );

    await expect(
      fetchEvmBlockHeader("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] }),
    ).resolves.toEqual({
      number: 16,
      timestamp: 100,
      hash: `0x${"a".repeat(64)}`,
    });
    await expect(
      fetchEvmBlockHeader("ethereum", 16, { extraRpcUrls: ["https://rpc.example"] }),
    ).resolves.toBeNull();
  });

  it("resolves an explicitly finalized block header without relabeling latest state", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            number: "0x10",
            timestamp: "0x64",
            hash: `0x${"c".repeat(64)}`,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchEvmBlockHeader("ethereum", "finalized", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toEqual({
      number: 16,
      timestamp: 100,
      hash: `0x${"c".repeat(64)}`,
    });
    const lastCall =
      fetchWithRetryMock.mock.calls[fetchWithRetryMock.mock.calls.length - 1];
    const body = JSON.parse(String(lastCall?.[1]?.body)) as {
      params: unknown[];
    };
    expect(body.params).toEqual(["finalized", false]);
  });

  it("resolves a canonical block header at the safe tag", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            number: "0x20",
            timestamp: "0x80",
            hash: `0x${"D".repeat(64)}`,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toEqual({
      number: 32,
      timestamp: 128,
      hash: `0x${"d".repeat(64)}`,
    });
    const body = JSON.parse(String(fetchWithRetryMock.mock.calls[0]?.[1]?.body)) as {
      params: unknown[];
    };
    expect(body.params).toEqual(["safe", false]);
  });

  it("rejects a malformed safe block header", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            number: "not-hex",
            timestamp: "0x80",
            hash: "0xmalformed",
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBeNull();
  });

  it("rejects a safe block header with a missing required field", async () => {
    fetchWithRetryMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          result: {
            number: "0x20",
            hash: `0x${"e".repeat(64)}`,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
      }),
    ).resolves.toBeNull();
  });

  it("returns null when the safe block header request errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(
      fetchEvmBlockHeaderAtTag("gnosis", "safe", {
        extraRpcUrls: ["https://rpc.example"],
        maxRetries: 0,
      }),
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[evm-rpc] eth_getBlockByNumber failed across 1 RPCs"),
    );
    warnSpy.mockRestore();
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

  it("brackets a near-tip scoring clock without probing pruned deep history", async () => {
    fetchWithRetryMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x3e3" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { timestamp: "0x3de" } }), { status: 200 }));

    const block = await resolveClosestBlockAtOrBeforeTimestamp(
      "sei",
      990,
      {
        latestBlockNumber: 100,
        blockTimestampByNumber: new Map([[100, 1000]]),
      },
      { extraRpcUrls: ["https://rpc.example"] },
    );

    expect(block).toBe(98);
    const requestedBlockTags = fetchWithRetryMock.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { params: unknown[] };
      return body.params[0];
    });
    expect(requestedBlockTags).toEqual(["0x63", "0x62"]);
    expect(requestedBlockTags).not.toContain("0x32");
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
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "0x12c" }), { status: 200 }));

    const result = await fetchEtherscanUint256AtBlock(1, "0xToken", "0x18160ddd", "latest", {
      apiKey: "etherscan-key",
    });

    expect(result).toBe(300n);
  });

  it("logs summary when all RPCs fail for fetchEvmCallHexAtBlock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchWithRetryMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: -32000, message: "nope" } }), { status: 200 }),
    );

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
    fetchWithRetryMock.mockResolvedValue(new Response(JSON.stringify({ result: "not-hex" }), { status: 200 }));

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
