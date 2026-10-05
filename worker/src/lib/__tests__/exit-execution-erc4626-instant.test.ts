import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import type { ExitExecutionCertificate, ExitExecutionModelReview } from "@shared/types/exit-route";
import { observeErc4626InstantExit } from "../exit-execution/erc4626-instant";
import { observeReviewedExitExecutionRoutes } from "../exit-execution/runtime";
import { selectV9ExitStressRequest, resolveV9ExitCapacityAtRequest } from "@shared/lib/safety-score-v9/exit";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { getRedemptionBackstopConfig, validateRedemptionOutputIdentity } from "@shared/lib/redemption-backstops";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { resolveCapacityBasis, resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import type { StablecoinsCacheLoadOk } from "../stablecoins-cache";

const CLOCK = 1_791_184_659;
const VAULT = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const HASH = `0x${"1".repeat(64)}`;
const MULTICALL = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const state = vi.hoisted(() => ({ liquidity: 1_000_000_000_000_000n, feeBps: 0n, maxBps: 10_000n, paused: false, override: "supported", identity: false, code: false, realizedMismatch: false, redeemFails: false, nonBinding: false, reorg: false, headers: 0 }));
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
vi.mock("../evm-rpc", () => ({
  MULTICALL3_ADDRESS: "0xca11bde05977b3631167028862be2a173976ca11",
  fetchEvmBlockNumber: async () => 100,
  fetchEvmBlockHeader: async () => ({ number: 100, hash: state.reorg && state.headers++ > 0 ? `0x${"2".repeat(64)}` : HASH, timestamp: CLOCK }),
  fetchEvmCodeAtBlock: async () => state.code ? "0x6001" : "0x6000",
  fetchEvmStorageAtBlock: async () => word(0n),
  fetchEvmRpcBatchDetailed: async (_chain: string, calls: { method: string; params: unknown[] }[]) => {
    const results: unknown[] = []; const errors: { index: number }[] = [];
    for (const [index, call] of calls.entries()) {
      if (call.method === "eth_chainId") { results.push("0x1"); continue; }
      const tx = call.params[0] as { data: `0x${string}`; to: string };
      const override = call.params[2] as Record<string, { stateDiff: Record<string, string> }> | undefined;
      const shares = override ? BigInt(Object.values(override[VAULT]!.stateDiff)[0]!) : 0n;
      if (override && state.override === "unsupported") { errors.push({ index }); results.push(undefined); continue; }
      const selector = tx.data.slice(0, 10);
      const amount = tx.data.length >= 74 ? BigInt("0x" + tx.data.slice(10, 74)) : 0n;
      if (selector === toFunctionSelector("aggregate3((address,bool,bytes)[])")) {
        const decoded = decodeFunctionData({ abi: MULTICALL, data: tx.data });
        const redeemData = decoded.args![0][2]!.callData;
        const executed = BigInt("0x" + redeemData.slice(10, 74));
        const succeeds = !state.redeemFails && executed <= state.liquidity;
        const received = executed * (10_000n - state.feeBps) / 10_000n;
        results.push(encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [[
          { success: true, returnData: word(7n) }, { success: true, returnData: word(shares) },
          { success: succeeds, returnData: succeeds ? word(received) : "0x" },
          { success: true, returnData: word(7n + (succeeds ? received + (state.realizedMismatch ? 1n : 0n) : 0n)) },
          { success: true, returnData: word(shares - (succeeds ? executed : 0n)) },
        ]]));
        continue;
      }
      const quotedMaximum = (shares < state.liquidity ? shares : state.liquidity) * state.maxBps / 10_000n;
      const values: Record<string, bigint> = {
        [toFunctionSelector("asset()")]: state.identity ? 3n : 2n,
        [toFunctionSelector("decimals()")]: 6n,
        [toFunctionSelector("totalSupply()")]: 1_000_000_000_000_000n,
        [toFunctionSelector("balanceOf(address)")]: tx.to === TOKEN ? state.liquidity : state.override === "ignored" ? 0n : shares,
        [toFunctionSelector("maxRedeem(address)")]: state.nonBinding ? 0n : quotedMaximum,
        [toFunctionSelector("maxWithdraw(address)")]: state.nonBinding ? 0n : quotedMaximum,
        [toFunctionSelector("convertToAssets(uint256)")]: amount,
        [toFunctionSelector("convertToShares(uint256)")]: amount,
        [toFunctionSelector("previewRedeem(uint256)")]: amount * (10_000n - state.feeBps) / 10_000n,
        [toFunctionSelector("paused()")]: state.paused ? 1n : 0n,
      };
      if (!(selector in values)) throw new Error(`unexpected fixture selector ${selector}`);
      results.push(word(values[selector]!));
    }
    return { results, errors };
  },
}));
const review: ExitExecutionModelReview = {
  modelId: "erc4626-instant", holder: "any-holder", reviewedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-04T00:00:00.000Z",
  identity: { assetId: "fixture-vault", deployment: `ethereum:${VAULT}`, endpoint: `ethereum:${VAULT}`, outputAssetKeys: ["fixture-underlying"], implementationIdentity: `sha256:${sha256Hex("0x6000")}` },
  evidenceIds: ["fixture-verified-synchronous-source"], sourceUrls: ["https://example.com/verified-vault"],
  producer: { kind: "erc4626-instant", chain: "ethereum", chainId: 1, contract: VAULT, outputToken: TOKEN, inputDecimals: 6, outputDecimals: 6,
    codeSha256: sha256Hex("0x6000"), multicallCodeSha256: sha256Hex("0x6000"), balanceStorage: { slot: word(1n), keyOrder: "account-slot" },
    maxFunctions: "binding", unrestrictedGateSelectors: [], pausedSelector: toFunctionSelector("paused()") },
};
const inputReference: ExitExecutionCertificate["inputReference"] = { assetKey: "fixture-vault", deployment: review.identity.deployment, rawUnits: "0", decimals: 6,
  unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-price", sourceGenerationId: "fixture-price", observedAtSec: CLOCK };
const outputReference = { ...inputReference, assetKey: "fixture-underlying", deployment: `ethereum:${TOKEN}` };
const args = { review, inputReference, outputReference, requests: [{ requestedNotionalUsd: 100_000, maxCostBps: 200 }] };
beforeEach(() => { Object.assign(state, { liquidity: 1_000_000_000_000_000n, feeBps: 0n, maxBps: 10_000n, paused: false, override: "supported", identity: false, code: false, realizedMismatch: false, redeemFails: false, nonBinding: false, reorg: false, headers: 0 }); vi.useFakeTimers(); vi.setSystemTime(CLOCK * 1000); });
afterEach(() => vi.useRealTimers());

describe("reviewed synchronous ERC4626 exact execution", () => {
  it("certifies the full stress request only after observing the same-call output transfer and share burn", async () => {
    const result = await observeErc4626InstantExit(args);
    expect(result.points[0]).toMatchObject({ executableUsd: 100_000, requestedRawInput: "100000000000", executedRawInput: "100000000000", certification: "exact-complete", outputs: [{ rawUnits: "100000000000" }] });
    expect(result.source).toMatchObject({ number: 100, hash: HASH, complete: true, truncated: false });
    state.realizedMismatch = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it.each([9_999n, 0n])("proves full execution even when ordinary max functions conservatively underestimate at %s bps", async (maxBps) => {
    state.maxBps = maxBps;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({ executableUsd: 100_000, certification: "exact-complete", executedRawInput: "100000000000" });
  });
  it("keeps liquidity-limited execution at its exact 0.4 completion without claiming exhaustion", async () => {
    state.liquidity = 40_000_000_000n;
    const point = (await observeErc4626InstantExit(args)).points[0]!;
    expect(point).toMatchObject({ executableUsd: 40_000, executedRawInput: "40000000000", certification: "exact-lower-bound", reason: "erc4626-liquidity-limited" });
    expect(point.executableUsd / point.requestedNotionalUsd).toBe(0.4);
  });
  it("records paused or withdrawal-disabled zero completion with a machine reason", async () => {
    state.paused = true;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({ executableUsd: 0, certification: "exact-lower-bound", reason: "erc4626-paused" });
    state.paused = false; state.liquidity = 0n;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({ executableUsd: 0, reason: "erc4626-withdrawal-disabled" });
  });
  it.each(["unsupported", "ignored"])("rejects %s state override instead of relabelling a quote as a lower bound", async (mode) => {
    state.override = mode;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-state-override-unsupported");
  });
  it("quantifies a 50bps withdrawal fee in output units exactly once", async () => {
    state.feeBps = 50n;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({ certification: "exact-complete", executionCostBps: 50, allInCostBps: 50, fees: [{ rawUnits: "500000000" }], outputs: [{ rawUnits: "99500000000" }] });
  });
  it("rejects substituted deployment, underlying identity and bytecode", async () => {
    await expect(observeErc4626InstantExit({ ...args, outputReference: { ...outputReference, deployment: `base:${TOKEN}` } })).rejects.toThrow("erc4626-route-identity-mismatch");
    state.identity = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-asset-identity-mismatch");
    state.identity = false; state.code = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-code-identity-mismatch");
  });
  it("admits Morpho V2's reviewed non-binding zero max functions only with successful actual execution", async () => {
    state.nonBinding = true;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    expect((await observeErc4626InstantExit({ ...args, review: v2Review })).points[0]!.certification).toBe("exact-complete");
    state.redeemFails = true;
    expect((await observeErc4626InstantExit({ ...args, review: v2Review })).points[0]).toMatchObject({ executableUsd: 0, certification: "diagnostic", reason: "erc4626-redeem-reverted" });
  });
  it("measures V2's smaller idle-backed execution after a full request reverts, never granting idle alone", async () => {
    state.nonBinding = true; state.liquidity = 40_000_000_000n;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    expect((await observeErc4626InstantExit({ ...args, review: v2Review })).points[0]).toMatchObject({ executableUsd: 40_000, certification: "exact-lower-bound", reason: "erc4626-liquidity-limited" });
    state.redeemFails = true;
    expect((await observeErc4626InstantExit({ ...args, review: v2Review })).points[0]).toMatchObject({ executableUsd: 0, certification: "diagnostic", reason: "erc4626-redeem-reverted" });
  });
  it("rejects a reorganized source and keeps over-budget observations diagnostic", async () => {
    state.reorg = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-source-reorg");
    state.reorg = false; state.feeBps = 201n;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({ executableUsd: 100_000, executionCostBps: 201, certification: "diagnostic", reason: "erc4626-cost-exceeds-request", outputs: [{ rawUnits: "97990000000" }] });
  });
  it("dispatches an admitted atomic certificate at the canonical supply-sized grid request", async () => {
    const circulatingUsd = 210_000_000;
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const request = selectV9ExitStressRequest(circulatingUsd, envelope)!;
    expect(request.requestedNotionalUsd).toBe(25_000_000);
    const result = await observeReviewedExitExecutionRoutes({ assetId: "fixture-vault", circulatingUsd, clockSec: CLOCK, lane: "redemption", reviews: [review], inputReference, outputReference, envelope });
    expect(result.failures).toEqual([]);
    const observation = result.observations[0]!;
    expect(observation).toMatchObject({ scoreEligible: true, completionRatio: 1, executionModelId: "erc4626-instant", executionCertificate: { settlement: { maximumCompletionSec: 0 } } });
    expect(resolveV9ExitCapacityAtRequest(observation.capacityCurve!.map(point => ({ ...point, executionCostBps: point.executionCostBps! })), request)?.completionRatio).toBe(1);
    expect(observation.executionCertificate!.points.every(point => point.certification === "exact-complete")).toBe(true);
  });
  it.each(["steakusdg-steakhouse", "krusdc-keyrock", "steakeurcv-steakhouse", "susdc-spark-v1"])("keeps %s scheduled baseline capacity unquantified without an execution receipt", async (assetId) => {
    const config = getRedemptionBackstopConfig(assetId)!;
    expect(RedemptionBackstopConfigSchema.safeParse(config).success).toBe(true);
    const db = { prepare() { throw new Error("unquantified baseline must not read an invented capacity"); } } as unknown as D1Database;
    const capacity = await resolveRedemptionCapacity(db, assetId, config.capacityModel, 1_000_000_000, CLOCK);
    expect(resolveCapacityBasis(config.routeFamily, config.capacityModel, capacity.capacityConfidence)).toBeUndefined();
    expect(capacity).toMatchObject({
      immediateCapacityUsd: null, immediateCapacityRatio: null, scoringCapacityUsd: null, scoringCapacityRatio: null,
      eventualCapacityUsd: null, eventualCapacityRatio: null, resolutionState: "missing-capacity",
      capacityProfile: { immediateUsd: null, eventualUsd: null, scoringUsd: null, scoringHorizon: "unknown" },
    });
  });
  it("keeps legacy Spark's measured USDC endpoint distinct from its alternate sUSDS exit", () => {
    expect(validateRedemptionOutputIdentity("susdc-spark-v1", { kind: "tracked-stablecoin", assetKeys: ["usdc-circle"], trackedAssetIds: ["usdc-circle"] })).toEqual([]);
    expect(validateRedemptionOutputIdentity("susdc-spark-v1", { kind: "tracked-stablecoin", assetKeys: ["susds-sky"], trackedAssetIds: ["susds-sky"] })).toContainEqual({ code: "output-identity-mismatch" });
  });
  it("admits observed cached prices without another D1 read and rejects a nominal-reference replacement", async () => {
    const cache: StablecoinsCacheLoadOk = {
      kind: "ok", updatedAt: CLOCK - 60,
      payload: { peggedAssets: [
        makeAsset({ id: "fixture-vault", price: 1, priceSource: "coingecko", priceObservedAt: CLOCK }),
        makeAsset({ id: "fixture-underlying", price: 1, priceSource: "coingecko", priceObservedAt: CLOCK }),
      ] },
    };
    const db = { prepare() { throw new Error("preloaded cache must not trigger another read"); } } as unknown as D1Database;
    const call = { assetId: "fixture-vault", circulatingUsd: 210_000_000, clockSec: CLOCK, lane: "redemption" as const, db, stablecoinsCache: cache, reviews: [review] };
    const admitted = await observeReviewedExitExecutionRoutes(call);
    expect(admitted.failures).toEqual([]);
    expect(admitted.observations[0]).toMatchObject({ scoreEligible: true, completionRatio: 1 });
    expect(admitted.observations[0]!.executionCertificate!.inputReference.sourceGenerationId).toBe(`stablecoins:${CLOCK - 60}`);
    cache.payload.peggedAssets[0]!.priceSource = "protocol-par";
    expect((await observeReviewedExitExecutionRoutes(call)).failures).toContainEqual({ modelId: "erc4626-instant", reason: "execution-price-reference-unavailable", responsibility: "producer-failed" });
  });
});
