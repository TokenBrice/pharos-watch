import { describe, expect, it, vi } from "vitest";
import { reserveDegradedWarning } from "../warnings";
import {
  addressObservation,
  boolObservation,
  executeEvmObservationPlan,
  uint256Observation,
} from "../evm-observation-plan";

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

describe("executeEvmObservationPlan", () => {
  it("constructs labeled calls, decodes values, verifies identity, accumulates warnings, and projects metadata", async () => {
    const expectedAddress = "0x1111111111111111111111111111111111111111";
    const read = vi.fn(async (calls) => calls.map((call) => ({
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
});
