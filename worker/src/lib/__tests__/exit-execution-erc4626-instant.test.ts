import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import type { ExitExecutionCertificate, ExitExecutionModelReview } from "@shared/types/exit-route";
import { observeErc4626InstantExit } from "../exit-execution/erc4626-instant";
import { observeReviewedExitExecutionRoutes } from "../exit-execution/runtime";
import { evaluateV9Exit, projectV9ExitEvaluationRoute, selectV9ExitStressRequest, resolveV9ExitCapacityAtRequest } from "@shared/lib/safety-score-v9/exit";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId, exitExecutionReviewDigest } from "@shared/lib/safety-score-v9/exit-execution";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { getRedemptionBackstopConfig, validateRedemptionOutputIdentity } from "@shared/lib/redemption-backstops";
import { RedemptionBackstopConfigSchema } from "@shared/lib/redemption-backstop-configs/schema";
import { resolveCapacityBasis, resolveRedemptionCapacity } from "../redemption-backstop/capacity";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import type { StablecoinsCacheLoadOk } from "../stablecoins-cache";
import type { FxRateState } from "../fx-rate-state";
import type * as EvmRpcModule from "../evm-rpc";
import { makeV9FixedInput, makeV9Extension } from "../../test-helpers/v9-fixed-input";
import { rebuildFixed } from "./safety-score-v9-fact-set.test-support";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";
import { buildSafetyScoreV9RouteReviews } from "../safety-score-v9/extension-routes";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";

const CLOCK = 1_791_184_659;
const VAULT = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const HASH = `0x${"1".repeat(64)}`;
const MULTICALL = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const state = vi.hoisted(() => ({ liquidity: 1_000_000_000_000_000n, idleLiquidity: null as bigint | null, rejectPartial: false, feeBps: 0n, grossPreview: false, grossReturn: false, escrowOnly: false, maxBps: 10_000n, paused: false, override: "supported", identity: false, code: false, realizedMismatch: false, redeemFails: false, nonBinding: false, reorg: false, headers: 0,
  feeShares: 0n, unexplainedSupplyDelta: 0n, feeRecipientDelta: null as bigint | null,
  deferIlliquid: false, optimisticMax: false, corruptOnlyFunded: false,
  feeGetter: "feeRecipient", feeRecipient: 3n, feeGetterChanged: false, feeBalanceFails: false, holderBurnMismatch: false, inverseOffset: 0n, outputDust: 0n }));
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
vi.mock("@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json", () => ({
  default: { schemaVersion: 1, get reviews() { return [review]; } },
}));
vi.mock("../evm-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof EvmRpcModule>()),
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
        const innerCalls = decoded.args![0];
        const redeem = innerCalls.find((entry) => entry.callData.slice(0, 10) === toFunctionSelector("redeem(uint256,address,address)"));
        const executed = redeem ? BigInt("0x" + redeem.callData.slice(10, 74)) : 0n;
        const succeeds = !state.redeemFails && (state.deferIlliquid || executed <= state.liquidity) && !(state.rejectPartial && executed < shares);
        const received = state.deferIlliquid && executed > state.liquidity ? 0n
          : executed * (10_000n - state.feeBps) / 10_000n - state.outputDust;
        let redeemed = false;
        const receipt = innerCalls.map((entry) => {
          const innerSelector = entry.callData.slice(0, 10);
          if (innerSelector === toFunctionSelector("redeem(uint256,address,address)")) {
            redeemed = succeeds;
            return { success: succeeds, returnData: succeeds ? word(state.grossReturn ? executed : received) : "0x" as `0x${string}` };
          }
          if (innerSelector === toFunctionSelector("totalSupply()")) return {
            success: true, returnData: word(1_000_000_000_000_000n + (redeemed ? state.feeShares + state.unexplainedSupplyDelta - (state.escrowOnly ? 0n : executed) : 0n)),
          };
          if (innerSelector === toFunctionSelector("balanceOf(address)")) {
            const owner = BigInt("0x" + entry.callData.slice(10, 74));
            const holder = owner === BigInt("0xca11bde05977b3631167028862be2a173976ca11");
            // eslint-disable-next-line security/detect-possible-timing-attacks -- mock routes by public token address, not a secret.
            if (entry.target.toLowerCase() === TOKEN) return {
              success: true, returnData: word(7n + (redeemed ? received + (state.realizedMismatch && (!state.corruptOnlyFunded || received > 0n) ? 1n : 0n) : 0n)),
            };
            if (holder) return { success: true, returnData: word(shares - (redeemed ? executed - (state.holderBurnMismatch ? 1n : 0n) : 0n)) };
            return { success: !state.feeBalanceFails, returnData: word(123n + (redeemed ? state.feeRecipientDelta ?? state.feeShares : 0n)) };
          }
          if (innerSelector === toFunctionSelector(`${state.feeGetter}()`)) return {
            success: true, returnData: word(state.feeRecipient + (redeemed && state.feeGetterChanged ? 1n : 0n)),
          };
          return { success: false, returnData: "0x" as `0x${string}` };
        });
        results.push(encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [receipt]));
        continue;
      }
      const quotedMaximum = (state.optimisticMax || shares < state.liquidity ? shares : state.liquidity) * state.maxBps / 10_000n;
      const values: Record<string, bigint> = {
        [toFunctionSelector("asset()")]: state.identity ? 3n : 2n,
        [toFunctionSelector("decimals()")]: 6n,
        [toFunctionSelector("totalSupply()")]: 1_000_000_000_000_000n,
        [toFunctionSelector("balanceOf(address)")]: tx.to === TOKEN ? state.idleLiquidity ?? state.liquidity : state.override === "ignored" ? 0n : shares,
        [toFunctionSelector("maxRedeem(address)")]: state.nonBinding ? 0n : quotedMaximum,
        [toFunctionSelector("maxWithdraw(address)")]: state.nonBinding ? 0n : quotedMaximum,
        [toFunctionSelector("convertToAssets(uint256)")]: amount,
        [toFunctionSelector("convertToShares(uint256)")]: amount > state.inverseOffset ? amount - state.inverseOffset : 0n,
        [toFunctionSelector("previewRedeem(uint256)")]: state.grossPreview ? amount : amount * (10_000n - state.feeBps) / 10_000n,
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
beforeEach(() => { Object.assign(state, { liquidity: 1_000_000_000_000_000n, idleLiquidity: null, rejectPartial: false, feeBps: 0n, grossPreview: false, grossReturn: false, escrowOnly: false, maxBps: 10_000n, paused: false, override: "supported", identity: false, code: false, realizedMismatch: false, redeemFails: false, nonBinding: false, reorg: false, headers: 0,
  deferIlliquid: false, optimisticMax: false, corruptOnlyFunded: false,
  feeShares: 0n, unexplainedSupplyDelta: 0n, feeRecipientDelta: null, feeGetter: "feeRecipient", feeRecipient: 3n, feeGetterChanged: false, feeBalanceFails: false, holderBurnMismatch: false, inverseOffset: 0n, outputDust: 0n }); vi.useFakeTimers(); vi.setSystemTime(CLOCK * 1000); });
afterEach(() => vi.useRealTimers());

describe("reviewed synchronous ERC4626 exact execution", () => {
  it("certifies the full stress request only after observing the same-call output transfer and share burn", async () => {
    const result = await observeErc4626InstantExit(args);
    expect(result.points[0]).toMatchObject({ executableUsd: 100_000, requestedRawInput: "100000000000", executedRawInput: "100000000000", certification: "exact-complete", outputs: [{ rawUnits: "100000000000" }] });
    expect(result.source).toMatchObject({ number: 100, hash: HASH, complete: true, truncated: false });
    state.realizedMismatch = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("admits an exact receipt when conservative conversion rounding is not a one-unit inverse", async () => {
    state.inverseOffset = 846_920n;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({
      certification: "exact-complete", executedRawInput: "100000000000", outputs: [{ rawUnits: "100000000000" }],
    });
    state.realizedMismatch = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("certifies a reviewed gross return and preview using the exact rebasing-token net receipt, not a dust tolerance", async () => {
    state.outputDust = 1n; state.grossPreview = true; state.grossReturn = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
    const grossReview = { ...review, producer: { ...review.producer, previewRedeem: "gross-before-fee", redeemReturns: "gross-before-fee" } } as ExitExecutionModelReview;
    expect((await observeErc4626InstantExit({ ...args, review: grossReview })).points[0]).toMatchObject({
      certification: "exact-complete", outputs: [{ rawUnits: "99999999999" }], fees: [{ rawUnits: "1" }],
    });
    state.holderBurnMismatch = true;
    await expect(observeErc4626InstantExit({ ...args, review: grossReview })).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it.each(["feeRecipient", "performanceFeeRecipient", "managementFeeRecipient"])("reconciles redeem-time fee shares only against the same-call configured %s balance", async (getter) => {
    state.feeGetter = getter;
    // Accrual can mint more shares than the holder burns: supply increases.
    state.feeShares = 1324860943254759196n;
    expect((await observeErc4626InstantExit(args)).points[0]).toMatchObject({
      certification: "exact-complete", executedRawInput: "100000000000", outputs: [{ rawUnits: "100000000000" }],
    });
    state.holderBurnMismatch = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("rejects unexplained supply increases and decreases despite an exact holder receipt", async () => {
    state.unexplainedSupplyDelta = 1n;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
    state.unexplainedSupplyDelta = -1n;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it.each(["missing-getter", "wrong-balance", "changed-getter", "unreadable-balance", "holder-recipient"])("rejects fee share mint with %s proof", async (failure) => {
    state.feeShares = 11n;
    if (failure === "missing-getter") state.feeGetter = "unsupportedFeeRecipient";
    if (failure === "wrong-balance") state.feeRecipientDelta = 10n;
    if (failure === "changed-getter") state.feeGetterChanged = true;
    if (failure === "unreadable-balance") state.feeBalanceFails = true;
    if (failure === "holder-recipient") state.feeRecipient = BigInt("0xca11bde05977b3631167028862be2a173976ca11");
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
  it("admits a source-reviewed gross preview only through the actual net receipt and retains default net-preview rejection", async () => {
    state.feeBps = 50n; state.grossPreview = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
    const grossReview = { ...review, producer: { ...review.producer, previewRedeem: "gross-before-fee" } } as ExitExecutionModelReview;
    expect((await observeErc4626InstantExit({ ...args, review: grossReview })).points[0]).toMatchObject({
      certification: "exact-complete", executionCostBps: 50, allInCostBps: 50,
      fees: [{ rawUnits: "500000000" }], outputs: [{ rawUnits: "99500000000" }],
    });
    state.realizedMismatch = true;
    await expect(observeErc4626InstantExit({ ...args, review: grossReview })).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("values a reviewed gross redeem return by actual net proceeds and rejects escrow transfers without share burn", async () => {
    state.feeBps = 50n; state.grossReturn = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
    const grossReturnReview = { ...review, producer: { ...review.producer, redeemReturns: "gross-before-fee" } } as ExitExecutionModelReview;
    expect((await observeErc4626InstantExit({ ...args, review: grossReturnReview })).points[0]).toMatchObject({
      certification: "exact-complete", executionCostBps: 50, outputs: [{ rawUnits: "99500000000" }],
    });
    state.escrowOnly = true;
    await expect(observeErc4626InstantExit({ ...args, review: grossReturnReview })).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("rejects a changed reviewed delegatecall dependency before simulating any capacity", async () => {
    const dependencyReview = { ...review, producer: { ...review.producer, dependencyCodeIdentities: [{
      address: "0x0000000000000000000000000000000000000003", codeSha256: sha256Hex("0x6001"),
    }] } } as ExitExecutionModelReview;
    await expect(observeErc4626InstantExit({ ...args, review: dependencyReview })).rejects.toThrow("erc4626-dependency-identity-mismatch");
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
  it("proves a near-complete V2 adapter-funded receipt even with zero idle and zero max functions", async () => {
    state.nonBinding = true; state.idleLiquidity = 0n; state.liquidity = 97_000_000_000n;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    const result = await observeErc4626InstantExit({ ...args, review: v2Review });
    expect(result.points[0]).toMatchObject({
      requestedRawInput: "100000000000", executedRawInput: "96875000000",
      executableUsd: 96_875, certification: "exact-lower-bound",
      reason: "erc4626-liquidity-limited", outputs: [{ rawUnits: "96875000000" }],
    });
    state.realizedMismatch = true;
    await expect(observeErc4626InstantExit({ ...args, review: v2Review })).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("re-measures a proven V2 ladder amount for larger requests when liquidity is in adapters, not idle", async () => {
    state.nonBinding = true; state.idleLiquidity = 0n; state.liquidity = 1_000_000_000_000n;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    const requests = [100_000, 1_000_000, 10_000_000, 25_000_000].map(requestedNotionalUsd => ({ requestedNotionalUsd, maxCostBps: 200 }));
    const points = (await observeErc4626InstantExit({ ...args, review: v2Review, requests })).points;
    expect(points.map(point => point.certification)).toEqual(["exact-complete", "exact-complete", "exact-lower-bound", "exact-lower-bound"]);
    expect(points[2]).toMatchObject({ requestedRawInput: "10000000000000", executedRawInput: "1000000000000", executableUsd: 1_000_000, reason: "erc4626-liquidity-limited", outputs: [{ rawUnits: "1000000000000" }] });
    expect(points[3]).toMatchObject({ requestedRawInput: "25000000000000", executedRawInput: "1000000000000", executableUsd: 1_000_000, reason: "erc4626-liquidity-limited" });
  });
  it("does not transplant an earlier V2 success when redeem fails with the larger holder balance", async () => {
    state.nonBinding = true; state.idleLiquidity = 0n; state.liquidity = 1_000_000_000_000n; state.rejectPartial = true;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    const requests = [1_000_000, 10_000_000].map(requestedNotionalUsd => ({ requestedNotionalUsd, maxCostBps: 200 }));
    const points = (await observeErc4626InstantExit({ ...args, review: v2Review, requests })).points;
    expect(points[0]!.certification).toBe("exact-complete");
    expect(points[1]).toMatchObject({ executedRawInput: "0", executableUsd: 0, certification: "diagnostic", reason: "erc4626-redeem-reverted", outputs: [] });
  });
  it("keeps an all-failing zero-idle V2 ladder diagnostic instead of inferring executable liquidity", async () => {
    state.nonBinding = true; state.idleLiquidity = 0n; state.liquidity = 0n;
    const v2Review = { ...review, producer: { ...review.producer, maxFunctions: "reviewed-non-binding-zero" } } as ExitExecutionModelReview;
    const requests = [100_000, 1_000_000].map(requestedNotionalUsd => ({ requestedNotionalUsd, maxCostBps: 200 }));
    const points = (await observeErc4626InstantExit({ ...args, review: v2Review, requests })).points;
    expect(points.every(point => point.executableUsd === 0 && point.certification === "diagnostic" && point.reason === "erc4626-redeem-reverted")).toBe(true);
  });
  it("certifies only the transferred instant lower bound when a larger redeem burns shares into a queue", async () => {
    state.deferIlliquid = true; state.optimisticMax = true; state.liquidity = 10_000_000_000n;
    const result = await observeErc4626InstantExit(args);
    expect(result.points[0]).toMatchObject({
      requestedRawInput: "100000000000", executedRawInput: "9375000000", executableUsd: 9_375,
      certification: "exact-lower-bound", reason: "erc4626-liquidity-limited",
      outputs: [{ rawUnits: "9375000000" }],
      canonicalAttempt: {
        outcome: "accepted-but-unfunded", requestedRawInput: "100000000000",
        shareBalanceBefore: "100000000000", shareBalanceAfter: "0",
        returnedRawOutput: "0", receivedRawOutput: "0",
        block: { number: 100, hash: HASH, timestamp: CLOCK },
      },
    });
    const admitted = await observeReviewedExitExecutionRoutes({
      assetId: "fixture-vault", circulatingUsd: 1_000_000, clockSec: CLOCK,
      reviews: [review], inputReference, outputReference,
    });
    expect(admitted.failures).toEqual([]);
    expect(admitted.observations[0]).toMatchObject({
      scoreEligible: true, requestedNotionalUsd: 100_000, completionRatio: 0.09375,
      executionCertificate: { settlement: { maximumCompletionSec: 0, scope: "executed-input-only" },
        points: [{ certification: "exact-lower-bound", canonicalAttempt: { outcome: "accepted-but-unfunded" } }] },
    });
    state.realizedMismatch = true; state.corruptOnlyFunded = true;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
  });
  it("never certifies queued share burns when every bounded probe transfers no underlying", async () => {
    state.deferIlliquid = true; state.optimisticMax = true; state.liquidity = 0n;
    await expect(observeErc4626InstantExit(args)).rejects.toThrow("erc4626-realized-output-inconsistent");
    const result = await observeReviewedExitExecutionRoutes({
      assetId: "fixture-vault", circulatingUsd: 10_000_000, clockSec: CLOCK,
      reviews: [review], inputReference, outputReference,
    });
    expect(result).toMatchObject({
      observations: [], failures: [{ reason: "erc4626-realized-output-inconsistent" }],
    });
  });
  it("replays the winning receipt for fee minting when the final probes are queued", async () => {
    state.deferIlliquid = true; state.optimisticMax = true; state.liquidity = 40_000_000_000n;
    state.feeShares = 10n;
    const result = await observeErc4626InstantExit(args);
    // 50% queued, 25% funded, 37.5% funded, 43.75% queued, 40.625% queued.
    expect(result.points[0]).toMatchObject({
      executedRawInput: "37500000000", executableUsd: 37_500,
      certification: "exact-lower-bound", outputs: [{ rawUnits: "37500000000" }],
      canonicalAttempt: {
        outcome: "accepted-but-unfunded", requestedRawInput: "100000000000",
        shareBalanceBefore: "100000000000", shareBalanceAfter: "0",
        totalSupplyBefore: "1000000000000000", totalSupplyAfter: "999900000000010",
        returnedRawOutput: "0", receivedRawOutput: "0",
      },
    });
  });
  it.each(["burn", "return", "supply"])("rejects an inconsistent canonical queue %s receipt before smaller probes", async (fault) => {
    state.deferIlliquid = true; state.optimisticMax = true; state.liquidity = 10_000_000_000n;
    if (fault === "burn") state.holderBurnMismatch = true;
    if (fault === "return") state.grossReturn = true;
    if (fault === "supply") state.unexplainedSupplyDelta = 1n;
    const result = await observeReviewedExitExecutionRoutes({
      assetId: "fixture-vault", circulatingUsd: 1_000_000, clockSec: CLOCK,
      reviews: [review], inputReference, outputReference,
    });
    expect(result.observations).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      reason: "erc4626-realized-output-inconsistent",
      canonicalAttempt: { outcome: "inconsistent-receipt", requestedRawInput: "100000000000",
        block: { number: 100, hash: HASH, timestamp: CLOCK } },
    });
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
    const result = await observeReviewedExitExecutionRoutes({ assetId: "fixture-vault", circulatingUsd, clockSec: CLOCK, reviews: [review], inputReference, outputReference, envelope });
    expect(result.failures).toEqual([]);
    const observation = result.observations[0]!;
    expect(observation.routeId).toBe(`execution:${exitExecutionReviewDigest(review)}`);
    expect(observation).toMatchObject({ routeFamily: "protocol-redemption", scoreEligible: true, completionRatio: 1, executionModelId: "erc4626-instant", executionCertificate: { settlement: { maximumCompletionSec: 0 } } });
    expect(resolveV9ExitCapacityAtRequest(observation.capacityCurve!.map(point => ({ ...point, executionCostBps: point.executionCostBps! })), request)?.completionRatio).toBe(1);
    expect(observation.executionCertificate!.points.every(point => point.certification === "exact-complete")).toBe(true);
    expect(observation.executionCertificate!.points).toHaveLength(1);
    expect(observation.executionCertificate!.points[0]!.requestedNotionalUsd).toBe(request.requestedNotionalUsd);
  });
  it("refreshes a stale share quote from pinned gross NAV and a fresh observed underlying price", async () => {
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const staleInput = { ...inputReference, observedAtSec: CLOCK - 72 * 3600, unitValueUsd: 1.1, expectedUnitValueUsd: 1.1 };
    const freshOutput = { ...outputReference, unitValueUsd: 0.9999999 };
    const call = { assetId: "fixture-vault", circulatingUsd: 210_000_000, clockSec: CLOCK, reviews: [review], inputReference: staleInput, outputReference: freshOutput, envelope };
    const result = await observeReviewedExitExecutionRoutes(call);
    expect(result.failures).toEqual([]);
    const certificate = result.observations[0]!.executionCertificate!;
    expect(certificate.inputReference).toMatchObject({
      sourceId: "erc4626-nav:observed-price", observedAtSec: CLOCK,
      unitValueUsd: 0.999999, expectedUnitValueUsd: 0.999999,
    });
    expect(certificate.inputReference.sourceGenerationId).not.toBe(staleInput.sourceGenerationId);
    expect(certificate.points[0]!.certification).toBe("exact-complete");
    const staleOutput = { ...freshOutput, observedAtSec: CLOCK - 72 * 3600 };
    expect((await observeReviewedExitExecutionRoutes({ ...call, outputReference: staleOutput })).failures)
      .toContainEqual({ modelId: "erc4626-instant", reason: "execution-price-stale", responsibility: "producer-failed" });
    const changedOutput = await observeReviewedExitExecutionRoutes({ ...call, outputReference: { ...freshOutput, sourceGenerationId: "different-output-generation" } });
    expect(changedOutput.observations[0]!.executionCertificate!.inputGenerationId).not.toBe(certificate.inputGenerationId);
  });
  it("derives an absent share reference only from reviewed pinned NAV and a fresh underlying price", async () => {
    const cache: StablecoinsCacheLoadOk = {
      kind: "ok", updatedAt: CLOCK - 60,
      payload: { peggedAssets: [
        makeAsset({ id: "fixture-vault", price: null, priceSource: null, priceObservedAt: null }),
        makeAsset({ id: "fixture-underlying", price: 0.99, priceSource: "coingecko", priceObservedAt: CLOCK }),
      ] },
    };
    const call = { assetId: "fixture-vault", circulatingUsd: 10_000_000, clockSec: CLOCK,
      stablecoinsCache: cache, reviews: [review] };
    const result = await observeReviewedExitExecutionRoutes(call);
    expect(result.failures).toEqual([]);
    expect(result.observations[0]).toMatchObject({ scoreEligible: true, completionRatio: 1 });
    expect(result.observations[0]!.routeId).toBe(`execution:${exitExecutionReviewDigest(review)}`);
    expect(result.observations[0]!.executionCertificate!.inputReference).toMatchObject({
      assetKey: "fixture-vault", deployment: review.identity.deployment, decimals: 6,
      unitValueUsd: 0.99, expectedUnitValueUsd: 0.99, sourceId: "erc4626-nav:coingecko", observedAtSec: CLOCK,
    });
    for (const observedAt of [CLOCK - 18_001, CLOCK + 1]) {
      cache.payload.peggedAssets[1]!.priceObservedAt = observedAt;
      expect((await observeReviewedExitExecutionRoutes(call))).toMatchObject({
        observations: [], failures: [{ reason: "execution-price-reference-unavailable" }],
      });
    }
    cache.payload.peggedAssets[1]!.priceObservedAt = CLOCK;
    state.identity = true;
    expect((await observeReviewedExitExecutionRoutes(call))).toMatchObject({
      observations: [], failures: [{ reason: "erc4626-asset-identity-mismatch" }],
    });
  });
  it("keeps fresh measured execution admitted across supply drift only while the canonical request stays unchanged", async () => {
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const producerSupply = 210_000_000;
    const produced = await observeReviewedExitExecutionRoutes({
      assetId: "fixture-vault", circulatingUsd: producerSupply, clockSec: CLOCK,
      reviews: [review], inputReference, outputReference, envelope,
    });
    const certificate = produced.observations[0]!.executionCertificate!;
    const admitAt = (circulatingUsd: number, clockSec = CLOCK) => {
      const request = selectV9ExitStressRequest(circulatingUsd, envelope)!;
      return admitExitExecutionCertificate({
        certificate, envelope, assetId: "fixture-vault", clockSec, request, reviews: [review],
        inputGenerationId: exitExecutionInputGenerationId("fixture-vault", request, certificate.inputReference),
        observationGenerationId: certificate.observationGenerationId,
      });
    };
    const driftedRequest = selectV9ExitStressRequest(211_000_000, envelope)!;
    expect(driftedRequest.rawSupplyRequestUsd).not.toBe(selectV9ExitStressRequest(producerSupply, envelope)!.rawSupplyRequestUsd);
    expect(admitAt(211_000_000)).toMatchObject({ state: "observed", point: { certification: "exact-complete" } });
    const changedRequest = selectV9ExitStressRequest(200_000_000, envelope)!;
    expect(certificate.points.some(point => point.requestedNotionalUsd === changedRequest.requestedNotionalUsd)).toBe(false);
    expect(admitAt(200_000_000)).toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
    expect(admitAt(211_000_000, CLOCK + certificate.sourceMaxAgeSec)).toMatchObject({ state: "observed" });
    expect(admitAt(211_000_000, CLOCK + certificate.sourceMaxAgeSec + 1)).toMatchObject({ state: "unavailable", reason: "execution-source-stale" });
  });
  it("re-admits the producer certificate at both fact compilation and Exit evaluation using the consumer's current request", async () => {
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const produced = await observeReviewedExitExecutionRoutes({
      assetId: "fixture-vault", circulatingUsd: 210_000_000, clockSec: CLOCK,
      reviews: [review], inputReference, outputReference, envelope,
    });
    const observation = produced.observations[0]!;
    const certificate = observation.executionCertificate!;
    const compileAt = (circulatingUsd: number, clockSec = CLOCK) => {
      const draft = structuredClone(makeV9FixedInput({
        assetId: "fixture-vault", clockSec, aggregateCirculating: { peggedUSD: circulatingUsd },
        includeDexObservations: false, includeDexCoverage: false,
      }));
      draft.redemptionGenerationId = "redemption:fixture-certified";
      draft.redemptionStale = false;
      draft.inputFreshness.redemptionBackstops = { updatedAt: CLOCK, ageSeconds: clockSec - CLOCK, stale: false };
      draft.redemptionBackstopMap["fixture-vault"] = makeSupplyFullRedemption({
        stablecoinId: "fixture-vault", updatedAt: CLOCK,
        capacityProfile: {
          immediateUsd: observation.executableUsd, eventualUsd: observation.executableUsd,
          scoringUsd: observation.executableUsd, scoringHorizon: "immediate",
          capacityProfileConfidence: "dynamic", modeledExitSizeUsd: observation.requestedNotionalUsd,
          exitRouteObservations: [observation],
        },
      });
      const fixed = rebuildFixed(draft);
      const extension = makeV9Extension({ assetId: "fixture-vault", clockSec, registryFingerprint: fixed.registryFingerprint });
      extension.routeFreshness.redemptionMaxAgeSec = certificate.sourceMaxAgeSec + 1;
      extension.assets[0]!.routeReviews = buildSafetyScoreV9RouteReviews(fixed, "fixture-vault");
      return compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!;
    };
    const asset = compileAt(211_000_000);
    const route = asset.exitRoutes.find(route => route.routeId === observation.routeId)!;
    expect(route).toMatchObject({ scoreEligible: true, coverageClass: "exact-complete", status: { observationState: "known" } });
    const evaluateAt = (circulatingUsd: number, clockSec = CLOCK) => evaluateV9Exit({
      assetId: "fixture-vault", clockSec, circulatingUsd, routes: [projectV9ExitEvaluationRoute(route)],
    }, envelope);
    expect(evaluateAt(212_000_000).routes[0]!.included).toBe(true);
    expect(evaluateAt(200_000_000).routes[0]!.included).toBe(false);
    expect(evaluateAt(212_000_000, CLOCK + certificate.sourceMaxAgeSec + 1).routes[0]!.included).toBe(false);
    for (const scenario of [
      { supply: 200_000_000, clockSec: CLOCK, reason: "execution-generation-mismatch" },
      { supply: 211_000_000, clockSec: CLOCK + certificate.sourceMaxAgeSec + 1, reason: "execution-source-stale" },
    ]) {
      const rejectedAsset = compileAt(scenario.supply, scenario.clockSec);
      const rejectedRoute = rejectedAsset.exitRoutes.find(route => route.routeId === observation.routeId)!;
      expect(rejectedRoute).toMatchObject({ scoreEligible: false, status: { observationState: "unsupported" } });
      expect(rejectedAsset.evidence.find(evidence => rejectedRoute.status.evidenceRefIds.includes(evidence.evidenceId)))
        .toMatchObject({ disposition: "rejected", rejection: { code: scenario.reason } });
    }
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
  it("uses observed prices or independently pinned NAV without admitting a nominal underlying reference", async () => {
    const cache: StablecoinsCacheLoadOk = {
      kind: "ok", updatedAt: CLOCK - 60,
      payload: { peggedAssets: [
        makeAsset({ id: "fixture-vault", price: 1, priceSource: "coingecko", priceObservedAt: CLOCK }),
        makeAsset({ id: "fixture-underlying", price: 1, priceSource: "coingecko", priceObservedAt: CLOCK }),
      ] },
    };
    const db = { prepare() { throw new Error("preloaded cache must not trigger another read"); } } as unknown as D1Database;
    const call = { assetId: "fixture-vault", circulatingUsd: 210_000_000, clockSec: CLOCK, db, stablecoinsCache: cache, reviews: [review] };
    const admitted = await observeReviewedExitExecutionRoutes(call);
    expect(admitted.failures).toEqual([]);
    expect(admitted.observations[0]).toMatchObject({ scoreEligible: true, completionRatio: 1 });
    expect(admitted.observations[0]!.executionCertificate!.inputReference.sourceGenerationId).toBe(`stablecoins:${CLOCK - 60}`);
    cache.payload.peggedAssets[0]!.priceSource = "protocol-par";
    const fromNav = await observeReviewedExitExecutionRoutes(call);
    expect(fromNav.failures).toEqual([]);
    expect(fromNav.observations[0]!.executionCertificate!.inputReference.sourceId).toBe("erc4626-nav:coingecko");
    cache.payload.peggedAssets[1]!.priceSource = "protocol-par";
    expect((await observeReviewedExitExecutionRoutes(call)).failures).toContainEqual({ modelId: "erc4626-instant", reason: "execution-price-reference-unavailable", responsibility: "producer-failed" });
  });
  it("measures EUR-denominated vault exits with observed token prices and a proven fresh FX reference", async () => {
    const cache: StablecoinsCacheLoadOk = {
      kind: "ok", updatedAt: CLOCK - 60,
      payload: { peggedAssets: [
        makeAsset({ id: "fixture-vault", price: 1.2, priceSource: "coingecko", priceObservedAt: CLOCK }),
        makeAsset({ id: "fixture-underlying", pegType: "peggedEUR", price: 1.2, priceSource: "coingecko", priceObservedAt: CLOCK }),
      ] },
    };
    const fxRateState: FxRateState = {
      rates: { peggedEUR: 1.2 }, usableSyncAt: CLOCK - 20, usableAgeSec: 20, mode: "live",
      sourceUpdatedAtByPeg: { peggedEUR: CLOCK - 30 }, sourceModeByPeg: { peggedEUR: "live" },
      sourceCadenceByPeg: { peggedEUR: "intraday" }, sourceDateByPeg: { peggedEUR: "2026-10-06" },
      sourceLastSuccessAtBySource: {},
      metadataIdentity: "verified", consecutiveFallbackRuns: 0,
    };
    const db = { prepare() { throw new Error("preloaded price and FX state must not read D1"); } } as unknown as D1Database;
    const call = { assetId: "fixture-vault", circulatingUsd: 210_000_000, clockSec: CLOCK, db, stablecoinsCache: cache, fxRateState, reviews: [review] };
    const result = await observeReviewedExitExecutionRoutes(call);
    expect(result.failures).toEqual([]);
    expect(result.observations[0]).toMatchObject({ scoreEligible: true, completionRatio: 1 });
    const reference = result.observations[0]!.executionCertificate!.points[0]!.outputs[0]!;
    expect(reference).toMatchObject({ unitValueUsd: 1.2, expectedUnitValueUsd: 1.2,
      sourceId: "coingecko+fx-rates:peggedEUR", observedAtSec: CLOCK - 30 });
    expect(reference.sourceGenerationId).not.toBe(`stablecoins:${CLOCK - 60}`);
    for (const invalid of [
      null,
      { ...fxRateState, metadataIdentity: "generation-mismatch" as const },
      { ...fxRateState, sourceUpdatedAtByPeg: { peggedEUR: null } },
      { ...fxRateState, sourceUpdatedAtByPeg: { peggedEUR: CLOCK + 1 } },
      { ...fxRateState, sourceUpdatedAtByPeg: { peggedEUR: CLOCK - 86_400 } },
    ]) {
      expect((await observeReviewedExitExecutionRoutes({ ...call, fxRateState: invalid })).failures)
        .toContainEqual({ modelId: "erc4626-instant", reason: "execution-price-reference-unavailable", responsibility: "producer-failed" });
    }
    cache.payload.peggedAssets[1]!.priceSource = "protocol-par";
    expect((await observeReviewedExitExecutionRoutes(call)).failures)
      .toContainEqual({ modelId: "erc4626-instant", reason: "execution-price-reference-unavailable", responsibility: "producer-failed" });
  });
});
