import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, toFunctionSelector } from "viem/utils";
import { sha256Hex } from "@shared/lib/sha256";
import { ExitExecutionModelReviewSchema, type ExitExecutionCertificate, type ExitExecutionModelReview } from "@shared/types/exit-route";
import { loadV9CandidateMethodologyPolicy } from "@shared/lib/safety-score-v9/policy";
import { admitExitExecutionCertificate, exitExecutionInputGenerationId } from "@shared/lib/safety-score-v9/exit-execution";
import { selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { observeErc4626InstantExit } from "../exit-execution/erc4626-instant";
import { observeReviewedExitExecutionRoutes } from "../exit-execution/runtime";

const CLOCK = 1_791_184_659;
const CUSTODIAN = "0x0000000000000000000000000000000000000011";
const SHARE = "0x0000000000000000000000000000000000000012";
const OUTPUT = "0x0000000000000000000000000000000000000013";
const FEED = "0x0000000000000000000000000000000000000014";
const HASH = `0x${"1".repeat(64)}`;
const MULTICALL = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"]);
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
const state = vi.hoisted(() => ({ approval: true, realizedMismatch: false, nativeAge: 0, nativeAnswer: 300_000_000_000n, gasFails: false, gasWrongBlock: false, ignoredOverride: false, changedShareCode: false, pins: [] as unknown[][] }));
vi.mock("../evm-rpc", () => ({
  MULTICALL3_ADDRESS: "0xca11bde05977b3631167028862be2a173976ca11",
  fetchEvmBlockNumber: async () => 100,
  fetchEvmBlockHeader: async () => ({ number: 100, hash: HASH, timestamp: CLOCK }),
  fetchEvmCodeAtBlock: async (_chain: string, address: string) => address === SHARE && state.changedShareCode ? "0x6001" : "0x6000",
  fetchEvmStorageAtBlock: async () => word(0n),
  fetchEvmRpcBatchDetailed: async (_chain: string, calls: { method: string; params: unknown[] }[]) => {
    const results: unknown[] = []; const errors: { index: number }[] = [];
    for (const [index, call] of calls.entries()) {
      state.pins.push(call.params);
      if (call.method === "eth_chainId") { results.push("0x1"); continue; }
      if (call.method === "eth_feeHistory") {
        results.push({ oldestBlock: state.gasWrongBlock ? "0x63" : "0x64", baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], reward: [["0x77359400"]] }); continue;
      }
      const tx = call.params[0] as { to: string; data: `0x${string}` };
      const override = call.params[2] as Record<string, { stateDiff: Record<string, string> }> | undefined;
      if (override) expect(Object.keys(override)).toEqual([SHARE]);
      const shares = override && !state.ignoredOverride ? BigInt(Object.values(override[SHARE]!.stateDiff)[0]!) : 0n;
      if (call.method === "eth_estimateGas") {
        expect(call.params[1]).toBe("0x64");
        const outer = decodeFunctionData({ abi: MULTICALL, data: tx.data }).args![0];
        expect(outer[2]!.allowFailure).toBe(false);
        if (state.gasFails) { errors.push({ index }); results.push(undefined); } else results.push("0x186a0");
        continue;
      }
      expect(call.params[1]).toEqual({ blockHash: HASH, requireCanonical: true });
      const selector = tx.data.slice(0, 10);
      const amount = tx.data.length >= 74 ? BigInt("0x" + tx.data.slice(10, 74)) : 0n;
      if (selector === toFunctionSelector("aggregate3((address,bool,bytes)[])")) {
        const outer = decodeFunctionData({ abi: MULTICALL, data: tx.data }).args![0];
        const nested = decodeFunctionData({ abi: MULTICALL, data: outer[2]!.callData }).args![0];
        expect(nested[0]!.target.toLowerCase()).toBe(SHARE);
        expect(nested[0]!.callData.slice(0, 10)).toBe(toFunctionSelector("approve(address,uint256)"));
        expect(nested[1]!.target.toLowerCase()).toBe(CUSTODIAN);
        const redeemed = BigInt("0x" + nested[1]!.callData.slice(10, 74));
        const received = redeemed * 995n / 1000n;
        const nestedResult = encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [[
          { success: true, returnData: word(state.approval ? 1n : 0n) }, { success: true, returnData: word(received) },
        ]]);
        results.push(encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [[
          { success: true, returnData: word(0n) }, { success: true, returnData: word(shares) },
          { success: true, returnData: nestedResult },
          { success: true, returnData: word(received + (state.realizedMismatch ? 1n : 0n)) },
          { success: true, returnData: word(shares - redeemed) },
          { success: true, returnData: word(10n ** 18n - redeemed) },
        ]])); continue;
      }
      if (selector === toFunctionSelector("latestRoundData()")) {
        results.push(encodeAbiParameters(parseAbiParameters("uint80,int256,uint256,uint256,uint80"), [1n, state.nativeAnswer, BigInt(CLOCK - state.nativeAge), BigInt(CLOCK - state.nativeAge), 1n])); continue;
      }
      const values: Record<string, bigint> = {
        [toFunctionSelector("asset()")]: BigInt(OUTPUT),
        [toFunctionSelector("frxUSD()")]: BigInt(SHARE),
        [toFunctionSelector("decimals()")]: tx.to === FEED ? 8n : 6n,
        [toFunctionSelector("totalSupply()")]: 10n ** 18n,
        [toFunctionSelector("balanceOf(address)")]: shares,
        [toFunctionSelector("convertToAssets(uint256)")]: amount,
        [toFunctionSelector("convertToShares(uint256)")]: amount,
        [toFunctionSelector("previewRedeem(uint256)")]: amount * 995n / 1000n,
        [toFunctionSelector("maxRedeem(address)")]: shares,
        [toFunctionSelector("maxWithdraw(address)")]: shares * 995n / 1000n,
      };
      if (!(selector in values)) throw new Error(`unexpected custodian selector ${selector}`);
      results.push(word(values[selector]!));
    }
    return { results, errors };
  },
}));
const review: ExitExecutionModelReview = {
  modelId: "erc4626-instant", holder: "any-holder", reviewedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-04T00:00:00.000Z",
  identity: { assetId: "fixture-custodian", deployment: `ethereum:${SHARE}`, endpoint: `ethereum:${CUSTODIAN}`, outputAssetKeys: ["fixture-output"], implementationIdentity: `sha256:${sha256Hex("0x6000")}` },
  evidenceIds: ["verified-external-share-layout"], sourceUrls: ["https://example.com/verified-custodian"],
  producer: { kind: "erc4626-instant", chain: "ethereum", chainId: 1, contract: CUSTODIAN, outputToken: OUTPUT,
    inputDecimals: 6, outputDecimals: 6, codeSha256: sha256Hex("0x6000"), multicallCodeSha256: sha256Hex("0x6000"),
    balanceStorage: { slot: word(0n), keyOrder: "account-slot" }, maxFunctions: "binding", unrestrictedGateSelectors: [],
    externalShareToken: { address: SHARE, codeSha256: sha256Hex("0x6000"), identitySelector: toFunctionSelector("frxUSD()"),
      primaryRedemptionRouteId: "redemption:fixture-custodian:stablecoin-redeem", nativeUsdFeed: { address: FEED, codeSha256: sha256Hex("0x6000"), maxAgeSec: 3600 } },
  },
};
const inputReference: ExitExecutionCertificate["inputReference"] = { assetKey: "fixture-custodian", deployment: review.identity.deployment, rawUnits: "0", decimals: 6,
  unitValueUsd: 1, expectedUnitValueUsd: 1, sourceId: "observed-price", sourceGenerationId: "fixture-price", observedAtSec: CLOCK };
const outputReference = { ...inputReference, assetKey: "fixture-output", deployment: `ethereum:${OUTPUT}` };
const args = { review, inputReference, outputReference, requests: [{ requestedNotionalUsd: 100_000, maxCostBps: 200 }] };
beforeEach(() => { Object.assign(state, { approval: true, realizedMismatch: false, nativeAge: 0, nativeAnswer: 300_000_000_000n, gasFails: false, gasWrongBlock: false, ignoredOverride: false, changedShareCode: false, pins: [] }); vi.useFakeTimers(); vi.setSystemTime(CLOCK * 1000); });
afterEach(() => vi.useRealTimers());

describe("exact external-share custodian runtime witness", () => {
  it("binds the exact requested units, approval, burn, output and priced gas to one block", async () => {
    expect(ExitExecutionModelReviewSchema.safeParse(review).success).toBe(true);
    const result = await observeErc4626InstantExit(args);
    expect(result.points[0]).toMatchObject({ certification: "exact-complete", requestedRawInput: "100000000000", executedRawInput: "100000000000",
      executableUsd: 100_000, executionCostBps: 50.09, allInCostBps: 50.09,
      fees: [{ rawUnits: "500000000" }, { kind: "gas", rawUnits: "300000000000000", assetKey: "asset:eth" }], outputs: [{ rawUnits: "99500000000" }] });
    expect(result.nativeReference).toMatchObject({ sourceId: `chainlink:${FEED}`, observedAtSec: CLOCK, unitValueUsd: 3000 });
    expect(result.source.hash).toBe(HASH);
  });
  it.each([
    ["approval", false, "erc4626-approval-receipt-invalid"],
    ["realizedMismatch", true, "erc4626-realized-output-inconsistent"],
    ["nativeAge", 3601, "erc4626-native-price-unavailable"],
    ["nativeAnswer", 0n, "erc4626-native-price-unavailable"],
    ["gasFails", true, "erc4626-pinned-gas-unavailable"],
    ["gasWrongBlock", true, "erc4626-pinned-gas-unavailable"],
    ["ignoredOverride", true, "erc4626-state-override-unsupported"],
    ["changedShareCode", true, "erc4626-share-token-identity-mismatch"],
  ] as const)("fails closed on %s without manufacturing a total fee or capacity", async (field, value, reason) => {
    Object.assign(state, { [field]: value });
    await expect(observeErc4626InstantExit(args)).rejects.toThrow(reason);
  });
  it("publishes the exact primary rail certificate, then rejects omitted gas or stale native FX at consumption", async () => {
    const envelope = loadV9CandidateMethodologyPolicy(CLOCK);
    const request = selectV9ExitStressRequest(1_000_000, envelope)!;
    const produced = await observeReviewedExitExecutionRoutes({ assetId: "fixture-custodian", circulatingUsd: 1_000_000, clockSec: CLOCK,
      envelope, reviews: [review], inputReference, outputReference });
    expect(produced.failures).toEqual([]);
    const observation = produced.observations[0]!;
    expect(observation).toMatchObject({ routeId: "redemption:fixture-custodian:stablecoin-redeem", scoreEligible: true });
    const certificate = observation.executionCertificate!;
    const admit = (candidate: ExitExecutionCertificate, clockSec = CLOCK) => admitExitExecutionCertificate({ certificate: candidate, envelope,
      assetId: "fixture-custodian", clockSec, request, reviews: [review], observationGenerationId: candidate.observationGenerationId,
      inputGenerationId: exitExecutionInputGenerationId("fixture-custodian", request, candidate.inputReference) });
    expect(admit(certificate).state).toBe("observed");
    const missingGas = structuredClone(certificate);
    missingGas.points[0]!.fees = missingGas.points[0]!.fees.filter(fee => fee.kind !== "gas");
    expect(admit(missingGas)).toMatchObject({ state: "unavailable", reason: "execution-custodian-gas-unproven" });
    expect(admit(certificate, CLOCK + 3601)).toMatchObject({ state: "unavailable", reason: "execution-custodian-gas-unproven" });
    const changedRequest = { ...request, requestedNotionalUsd: request.requestedNotionalUsd + 1 };
    expect(admitExitExecutionCertificate({ certificate, envelope, assetId: "fixture-custodian", clockSec: CLOCK, request: changedRequest, reviews: [review],
      observationGenerationId: certificate.observationGenerationId, inputGenerationId: exitExecutionInputGenerationId("fixture-custodian", changedRequest, inputReference) }))
      .toMatchObject({ state: "unavailable", reason: "execution-generation-mismatch" });
  });
});
