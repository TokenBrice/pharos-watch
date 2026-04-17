import { describe, expect, it } from "vitest";
import { RPC_LOG_SCAN_WINDOWS } from "../evm-source";

// Regression guard: dRPC free tier rejects eth_getLogs ranges > 10_000 blocks with
// "ranges over 10000 blocks are not supported on freetier". Both windows for Gnosis
// must stay ≤ 10_000 so the sync can make forward progress.
describe("RPC_LOG_SCAN_WINDOWS.gnosis", () => {
  it("keeps both scan windows within dRPC free-tier cap", () => {
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.alchemy).toBeLessThanOrEqual(10_000);
    expect(RPC_LOG_SCAN_WINDOWS.gnosis.fallback).toBeLessThanOrEqual(10_000);
  });
});
