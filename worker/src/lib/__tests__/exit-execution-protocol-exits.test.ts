import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import type { ExitExecutionCertificate, ExitExecutionModelReview } from "@shared/types/exit-route";
import { observeSecuritizeOffRampExit } from "../exit-execution/securitize-offramp";

const state = vi.hoisted(() => ({ inventory: 100_000_000_000n, paused: false, executionFails: false, outputMismatch: false, wrongImplementation: false, beacon: false }));
const address = (suffix: number) => `0x${suffix.toString(16).padStart(40, "0")}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
vi.mock("../evm-rpc", () => ({
  fetchEvmBlockNumber: async () => 10,
  fetchEvmBlockHeader: async () => ({ number: 10, hash: "0x" + "1".repeat(64), timestamp: 1000 }),
  fetchEvmCodeAtBlock: async () => "0x6000",
  fetchEvmStorageAtBlock: async (_chain: string, target: string, slot: string) =>
    word(slot === "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"
      ? state.beacon ? 99n : 0n : target === address(1) ? state.wrongImplementation ? 99n : 2n : 0n),
  fetchEvmRpcBatchDetailed: async (_chain: string, calls: { method: string; params: unknown[] }[]) => {
    const results: unknown[] = [], errors: { index: number }[] = [];
    for (const [index, call] of calls.entries()) {
      if (call.method === "eth_estimateGas") { results.push("0x5208"); continue; }
      if (call.method === "eth_gasPrice") { results.push("0x1"); continue; }
      const request = call.params[0] as { data: string; to: string; from?: string };
      const selector = request.data.slice(0, 10);
      const amount = request.data.length >= 74 ? BigInt("0x" + request.data.slice(10, 74)) : 0n;
      if (selector === "0x7cbc2373") { if (state.executionFails) errors.push({ index }); results.push("0x"); continue; }
      const values: Record<string, bigint> = { "0x1ba46cfd": 4n, "0x5b8bec55": 3n, "0x43cd8f7e": state.outputMismatch ? 99n : 5n,
        "0x9d8af759": 6n, "0xd0fb0203": 7n, "0x5c975abb": state.paused ? 1n : 0n,
        "0xbfbd008e": 0n, "0x571a06ff": 1n, "0x74375359": state.inventory,
        "0x70a08231": 1_000_000_000_000n, "0xdd62ed3e": 1_000_000_000_000n,
        "0x5e345e73": amount * 999n / 1000n, "0xa18d74b0": amount };
      if (!(selector in values)) throw new Error("unexpected-call");
      results.push(word(values[selector]!));
    }
    return { results, errors };
  },
}));
const review: ExitExecutionModelReview = {
  modelId: "securitize-offramp", identity: { assetId: "fixture-fund", deployment: `ethereum:${address(4)}`, endpoint: `ethereum:${address(1)}`, outputAssetKeys: ["fixture-output"], implementationIdentity: `ethereum:${address(2)}` }, holder: "verified-customer", reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", evidenceIds: ["fixture-model"], sourceUrls: ["https://example.com/implementation"],
  producer: { kind: "securitize-offramp", chain: "ethereum", contract: address(1), implementation: address(2), provider: address(3), inputToken: address(4), outputToken: address(5), inputDecimals: 6, outputDecimals: 6, codeSha256: sha256Hex("0x6000"), implementationCodeSha256: sha256Hex("0x6000"), dependencyCodeIdentities: [3, 4, 5, 6, 7].map((id) => ({ address: address(id), codeSha256: sha256Hex("0x6000") })) },
};
const inputReference: ExitExecutionCertificate["inputReference"] = { assetKey: "fixture-fund", deployment: review.identity.deployment, rawUnits: "0", decimals: 6, unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "live-nav", sourceGenerationId: "price-1", observedAtSec: 1000 };
const outputReference = { ...inputReference, assetKey: "fixture-output", deployment: `ethereum:${address(5)}` };
const nativeReference = { ...inputReference, assetKey: "collateral:ETH", deployment: "ethereum:native", decimals: 18, unitValueUsd: 3000, expectedUnitValueUsd: 3000 };
const args = { review, inputReference, outputReference, nativeReference, holderAddress: address(8), requests: [{ requestedNotionalUsd: 100_000, maxCostBps: 200 }] };

beforeEach(() => Object.assign(state, { inventory: 100_000_000_000n, paused: false, executionFails: false, outputMismatch: false, wrongImplementation: false, beacon: false }));

describe("reviewed Securitize holder execution", () => {
  it("certifies passing exact-holder execution, but never turns a successful view quote into capacity after execution fails", async () => {
    const passing = await observeSecuritizeOffRampExit(args);
    expect(passing).toMatchObject({ assetBurn: false, twoStep: true, points: [{ executableUsd: 100_000, certification: "exact-lower-bound" }] });
    expect(passing.points[0]!.outputs[0]).toMatchObject({ assetKey: "fixture-output", rawUnits: "99900000000" });
    state.executionFails = true;
    expect((await observeSecuritizeOffRampExit(args)).points[0]).toMatchObject({ certification: "diagnostic", reason: "holder-execution-failed" });
  });
  it("proves a smaller execution under the stress denominator rather than scaling provider inventory up", async () => {
    state.inventory = 50_000_000_000n;
    const point = (await observeSecuritizeOffRampExit(args)).points[0]!;
    expect(point.certification).toBe("exact-lower-bound");
    expect(point.executableUsd).toBeLessThan(51_000);
    expect(point.outputs[0]!.rawUnits).toBe("49999999999");
  });
  it("refuses unknown holder eligibility, gas valuation, substituted output and implementation", async () => {
    expect((await observeSecuritizeOffRampExit({ ...args, holderAddress: undefined })).points[0]).toMatchObject({ certification: "diagnostic", reason: "approved-holder-context-unavailable" });
    expect((await observeSecuritizeOffRampExit({ ...args, nativeReference: undefined })).points[0]).toMatchObject({ certification: "diagnostic", reason: "execution-gas-valuation-unavailable" });
    state.outputMismatch = true;
    await expect(observeSecuritizeOffRampExit(args)).rejects.toThrow("offramp-route-identity-mismatch");
    state.outputMismatch = false; state.wrongImplementation = true;
    await expect(observeSecuritizeOffRampExit(args)).rejects.toThrow("offramp-implementation-unreviewed");
  });
  it("refuses an unreviewed beacon upgrade path even when proxy and implementation bytecode match", async () => {
    state.beacon = true;
    await expect(observeSecuritizeOffRampExit(args)).rejects.toThrow("offramp-beacon-implementation-unsupported");
  });
  it("retains pause and output depeg as adverse constraints instead of granting a nominal quote", async () => {
    state.paused = true;
    expect((await observeSecuritizeOffRampExit(args)).points[0]).toMatchObject({ certification: "diagnostic", reason: "offramp-paused-holder-scenario-unproven" });
    state.paused = false;
    expect((await observeSecuritizeOffRampExit({ ...args, outputReference: { ...outputReference, unitValueUsd: 0.9 } })).points[0]).toMatchObject({ certification: "diagnostic", reason: "execution-cost-exceeds-request" });
  });
});
