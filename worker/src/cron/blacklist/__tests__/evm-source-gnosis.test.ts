import { describe, expect, it } from "vitest";
import { RPC_LOG_SCAN_WINDOWS } from "../evm-source";
import { buildChainRpcs, logScanRpcEndpoints } from "../../../lib/chain-registry";

// Regression guard: dRPC free tier rejects eth_getLogs ranges > 10_000 blocks with
// "ranges over 10000 blocks are not supported on freetier". Both windows for Gnosis
// must stay ≤ 10_000 so the sync can make forward progress.
describe("RPC_LOG_SCAN_WINDOWS.gnosis", () => {
  it("keeps both scan windows within dRPC free-tier cap", () => {
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.alchemy).toBeLessThanOrEqual(10_000);
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.fallback).toBeLessThanOrEqual(10_000);
  });
});

describe("Gnosis Dwellir log admission", () => {
  it("includes only Gnosis with admission and restores incumbents on rollback", () => {
    const baseline = buildChainRpcs("alchemy", "drpc");
    const admitted = buildChainRpcs("alchemy", "drpc", { dwellirApiKey: "test" });
    const disabled = buildChainRpcs("alchemy", "drpc", {
      dwellirApiKey: "test", dwellirRoutingDisabledChains: new Set(["gnosis"]),
    });
    expect(logScanRpcEndpoints(admitted.get("gnosis"))[0]?.operator).toBe("dwellir");
    expect(logScanRpcEndpoints(admitted.get("base")).some((row) => row.operator === "dwellir")).toBe(false);
    expect(logScanRpcEndpoints(disabled.get("gnosis"))).toEqual(logScanRpcEndpoints(baseline.get("gnosis")));
    expect(logScanRpcEndpoints(baseline.get("gnosis")).some((row) => row.operator === "dwellir")).toBe(false);
  });
});
