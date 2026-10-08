import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchJsonWithRetryMock } = vi.hoisted(() => ({ fetchJsonWithRetryMock: vi.fn() }));
vi.mock("../../../lib/fetch-retry", () => ({
  fetchJsonWithRetry: fetchJsonWithRetryMock,
}));
import { reserveDegradedWarning } from "../warnings";
import {
  addressObservation,
  boolObservation,
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
  type EvmObservationTransportCall,
} from "../evm-observation-plan";

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

describe("pinnedBlockPlan", () => {
  const hash = `0x${"a".repeat(64)}`;
  const options = {
    chain: "rootstock",
    signal: new AbortController().signal,
    rpcUrl: "https://primary.example",
  };

  afterEach(() => {
    fetchJsonWithRetryMock.mockReset();
    vi.restoreAllMocks();
  });

  it("uses the timestamp of the exact numbered header behind the observed head", async () => {
    fetchJsonWithRetryMock
      .mockResolvedValueOnce({ response: new Response(), body: { result: "0x10" } })
      .mockResolvedValueOnce({
        response: new Response(),
        body: { result: { number: "0x10", timestamp: "0x64", hash } },
      });

    const plan = await pinnedBlockPlan(options);
    expect(plan.observedBlock).toEqual({ chain: "rootstock", number: 16, timestamp: 100 });
    expect(plan.ctx.observedBlock).toBe(plan.observedBlock);
    const requests = fetchJsonWithRetryMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "eth_blockNumber", params: [] },
      { method: "eth_getBlockByNumber", params: ["0x10", false] },
    ]);
  });

  it.each([
    { number: "0x11", timestamp: "0x64", hash },
    { number: "0x10", timestamp: "0x64" },
    { number: "0x10", timestamp: "0x64", hash: "0x1234" },
    { number: "0x10", timestamp: "invalid", hash },
    { number: "0x10", timestamp: "0x0", hash },
    { number: "0x10", timestamp: "0x20000000000000", hash },
  ])("rejects unusable headers without substituting another clock: %j", async (header) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchJsonWithRetryMock
      .mockResolvedValueOnce({ response: new Response(), body: { result: "0x10" } })
      .mockResolvedValueOnce({ response: new Response(), body: { result: header } });

    await expect(pinnedBlockPlan(options)).rejects.toThrow(/observation block header/);
    expect(fetchJsonWithRetryMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchJsonWithRetryMock.mock.calls[1][1].body).params).toEqual(["0x10", false]);
  });

  it("accepts a fallback exact-number header rather than the first provider's positive mismatched clock", async () => {
    fetchJsonWithRetryMock
      .mockResolvedValueOnce({ response: new Response(), body: { result: "0x10" } })
      .mockResolvedValueOnce({
        response: new Response(),
        body: { result: { number: "0x11", timestamp: "0xc8", hash } },
      })
      .mockResolvedValueOnce({
        response: new Response(),
        body: { result: { number: "0x10", timestamp: "0x64", hash: `0x${"b".repeat(64)}` } },
      });

    const plan = await pinnedBlockPlan({ ...options, fallbackRpcUrl: "https://fallback.example" });
    expect(plan.observedBlock).toEqual({ chain: "rootstock", number: 16, timestamp: 100 });
    expect(fetchJsonWithRetryMock.mock.calls.map((call) => call[0])).toEqual([
      "https://primary.example", "https://primary.example", "https://fallback.example",
    ]);
    for (const call of fetchJsonWithRetryMock.mock.calls.slice(1)) {
      expect(JSON.parse(call[1].body).params).toEqual(["0x10", false]);
    }
  });

  it("preserves injected anchor authority and does not rewrite the retained historical discrepancy", async () => {
    // RS3 E3 independently retained Rootstock header; this does not attribute
    // the production discrepancy to a particular transport response.
    const retained = { chain: "rootstock", number: 9305511, timestamp: 1791404146 };
    const ctx = { observedBlock: retained };
    const injected = await pinnedBlockPlan({ ...options, ctx });
    expect(injected.observedBlock).toBe(retained);
    expect(injected.ctx).toBe(ctx);
    expect(fetchJsonWithRetryMock).not.toHaveBeenCalled();

    fetchJsonWithRetryMock
      .mockResolvedValueOnce({
        response: new Response(),
        body: { result: `0x${retained.number.toString(16)}` },
      })
      .mockResolvedValueOnce({
        response: new Response(),
        body: {
          result: {
            number: `0x${retained.number.toString(16)}`,
            timestamp: `0x${(1791404113).toString(16)}`,
            hash: "0xaf6b1778d69d7b3374c4588f36ef521eaddcc53a920e754aa866ad3d24bde23f",
          },
        },
      });
    const fresh = await pinnedBlockPlan(options);
    expect(fresh.observedBlock.timestamp).toBe(1791404113);
    expect(retained.timestamp - fresh.observedBlock.timestamp).toBe(33);
    expect(retained.timestamp).toBe(1791404146);
  });

  it("rejects injected anchors for another chain without replacing their authority", async () => {
    await expect(pinnedBlockPlan({
      ...options,
      ctx: { observedBlock: { chain: "ethereum", number: 16, timestamp: 100 } },
    })).rejects.toThrow(/chain mismatch/);
    expect(fetchJsonWithRetryMock).not.toHaveBeenCalled();
  });
});

describe("executeEvmObservationPlan", () => {
  it("constructs labeled calls, decodes values, verifies identity, accumulates warnings, and projects metadata", async () => {
    const expectedAddress = "0x1111111111111111111111111111111111111111";
    const read = vi.fn(async (calls: readonly EvmObservationTransportCall[]) => calls.map((call) => ({
      label: call.label,
      success: true,
      returnData: call.label === "asset"
        ? word(BigInt(expectedAddress))
        : call.label === "paused"
          ? word(1n)
          : word(123n),
    })));

    const fields = [
      addressObservation({
        label: "asset",
        contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        data: "0x38d52e0f",
        verify: (value) => value === expectedAddress ? null : "asset address drifted",
        metadata: "assetAddress",
      }),
      uint256Observation({
        label: "totalAssets",
        contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        data: "0x01e1d114",
        metadata: { key: "totalAssetsRaw", project: (value) => value.toString() },
      }),
      boolObservation({
        label: "paused",
        contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        data: "0x5c975abb",
        warning: (value) => value
          ? reserveDegradedWarning("route-paused", "The observed route is paused")
          : null,
      }),
    ] as const;

    const snapshot = await executeEvmObservationPlan({ adapterKey: "test-adapter", fields, read });

    expect(read).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: "asset", data: "0x38d52e0f" }),
        expect.objectContaining({ label: "totalAssets", data: "0x01e1d114" }),
        expect.objectContaining({ label: "paused", data: "0x5c975abb" }),
      ],
      undefined,
    );
    expect(snapshot.values).toEqual({ asset: expectedAddress, totalAssets: 123n, paused: true });
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ code: "route-paused" }),
    ]);
    expect(snapshot.metadata).toEqual({ assetAddress: expectedAddress, totalAssetsRaw: "123" });
  });

  it("fails closed on duplicate labels and missing required results", async () => {
    const duplicateFields = [
      uint256Observation({ label: "supply", contract: "0x1", data: "0x1" }),
      uint256Observation({ label: "supply", contract: "0x2", data: "0x2" }),
    ] as const;
    await expect(executeEvmObservationPlan({
      adapterKey: "duplicate-test",
      fields: duplicateFields,
      read: async () => [],
    })).rejects.toThrow("duplicate or empty label");

    const fields = [uint256Observation({ label: "supply", contract: "0x1", data: "0x1" })] as const;
    await expect(executeEvmObservationPlan({
      adapterKey: "missing-test",
      fields,
      read: async () => [{ label: "supply", success: false, returnData: "0x" }],
    })).rejects.toThrow("observation failed: supply");
  });

  it("preserves explicitly optional failed observations as null", async () => {
    const fields = [addressObservation({
      label: "optional-endpoint",
      contract: "0x1",
      data: "0x2",
      allowFailure: true,
      optional: true,
    })] as const;
    const snapshot = await executeEvmObservationPlan({
      adapterKey: "optional-test",
      fields,
      read: async () => [{ label: "optional-endpoint", success: false, returnData: "0x" }],
    });
    expect(snapshot.values["optional-endpoint"]).toBeNull();
  });

  it("anchors reads, verifies code identity before the batch, and projects anchor metadata", async () => {
    const fields = [uint256Observation({
      label: "supply",
      contract: "0x1",
      data: "0x2",
    })] as const;
    const read = vi.fn(async (_calls, anchor: { blockNumber: number }) => [{
      label: "supply",
      success: true,
      returnData: word(BigInt(anchor.blockNumber)),
    }]);
    const code = vi.fn(async (anchor: { blockNumber: number }) =>
      anchor.blockNumber === 123 ? "0x6000" : null);

    const snapshot = await executeEvmObservationPlan({
      adapterKey: "anchored-test",
      fields,
      anchor: {
        observe: async () => ({ blockNumber: 123, timestamp: 456 }),
        verify: (value) => value.timestamp === 456 ? null : "timestamp drifted",
        metadata: (value) => ({ blockNumber: value.blockNumber, blockTimestamp: value.timestamp }),
      },
      checks: [{
        label: "runtime-code",
        observe: code,
        verify: (value) => value === "0x6000" ? null : "runtime code drifted",
        metadata: "runtimeCode",
      }],
      read,
    });

    expect(read).toHaveBeenCalledWith(expect.any(Array), { blockNumber: 123, timestamp: 456 });
    expect(code).toHaveBeenCalledWith({ blockNumber: 123, timestamp: 456 });
    expect(snapshot.values.supply).toBe(123n);
    expect(snapshot.metadata).toEqual({ blockNumber: 123, blockTimestamp: 456, runtimeCode: "0x6000" });
  });

  it("rejects missing or invalid anchors and failed identity checks before dispatch", async () => {
    const fields = [uint256Observation({ label: "supply", contract: "0x1", data: "0x1" })] as const;
    const read = vi.fn();
    const observeIdentity = vi.fn(async () => "wrong-code");
    for (const anchorValue of [null, -1]) {
      await expect(executeEvmObservationPlan({
        adapterKey: "anchor-gate", fields, read,
        anchor: { observe: async () => anchorValue, verify: (value) => value < 0 ? "invalid block" : null },
        checks: [{ label: "code", observe: observeIdentity, verify: () => "code drift" }],
      })).rejects.toThrow(/observation block anchor/);
    }
    expect(observeIdentity).not.toHaveBeenCalled();
    for (const identity of [null, "wrong-code"]) {
      await expect(executeEvmObservationPlan({
        adapterKey: "identity-gate", fields, read,
        anchor: { observe: async () => 123 },
        checks: [{ label: "code", observe: async () => identity, verify: () => "code drift" }],
      })).rejects.toThrow(/observation check failed/);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects null, incomplete, unknown-label and duplicate-label transport results", async () => {
    const fields = ["a", "b"].map((label) => uint256Observation({ label, contract: "0x1", data: "0x1" }));
    const row = (label: string) => ({ label, success: true, returnData: word(1n) });
    for (const [results, error] of [
      [null, "transport failed"],
      [[row("a")], "count mismatch"],
      [[row("a"), row("foreign")], "unknown label"],
      [[row("a"), row("a")], "duplicate label"],
    ] as const) {
      await expect(executeEvmObservationPlan({
        adapterKey: "transport-gate", fields, read: async () => results,
      })).rejects.toThrow(error);
    }
  });

  it("decodes reordered results by label rather than position", async () => {
    const snapshot = await executeEvmObservationPlan({
      adapterKey: "reordered",
      fields: [
        uint256Observation({ label: "assets", contract: "0x1", data: "0x1" }),
        uint256Observation({ label: "supply", contract: "0x1", data: "0x2" }),
      ],
      read: async () => [
        { label: "supply", success: true, returnData: word(7n) },
        { label: "assets", success: true, returnData: word(11n) },
      ],
    });
    expect(snapshot.values).toEqual({ assets: 11n, supply: 7n });
  });

  it("rejects malformed successful payloads even for optional observations", async () => {
    for (const optional of [false, true]) {
      await expect(executeEvmObservationPlan({
        adapterKey: "decode-gate",
        fields: [addressObservation({ label: "asset", contract: "0x1", data: "0x1", optional })],
        read: async () => [{ label: "asset", success: true, returnData: "0x1234" }],
      })).rejects.toThrow("observation decode failed");
    }
  });

  it("verifies against all decoded fields including later declarations", async () => {
    const fields = [
      uint256Observation({
        label: "assets", contract: "0x1", data: "0x1",
        verify: (value, values) => value >= (values.supply as bigint) ? null : "underbacked",
      }),
      uint256Observation({ label: "supply", contract: "0x1", data: "0x2" }),
    ];
    for (const assets of [10n, 9n]) {
      const result = executeEvmObservationPlan({
        adapterKey: "cross-field", fields,
        read: async () => [
          { label: "assets", success: true, returnData: word(assets) },
          { label: "supply", success: true, returnData: word(10n) },
        ],
      });
      if (assets === 10n) expect((await result).values).toEqual({ assets: 10n, supply: 10n });
      else await expect(result).rejects.toThrow("underbacked");
    }
  });
});
