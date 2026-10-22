import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, parseAbi } from "viem/utils";
import captured from "./fixtures/home-curve-2026-10-21.json";
import {
  CURVE_HOME_3CRV_METAPOOL_POLICY as policy,
  shouldRetainCurveCompositePoolIdentity,
} from "@shared/lib/curve-composite-policies";
import {
  DexMeasuredExecutionTargetSchema,
  toDexMeasuredExecutionPublicProfile,
} from "@shared/types/measured-execution";
import { validateMeasuredExecutionProfile } from "@shared/lib/p4-exit-route-measured-profile-validation";
import { CURVE_CHAINS } from "../../dex-liquidity/constants";
import { buildCurveLookups } from "../../dex-liquidity/fetch-primary";
import {
  buildCurveCompositeMeasuredExecutionTarget,
  createCurveCompositeQuoteExecutor,
  validateCurveCompositeProfileProof,
  verifyCurveCompositeDeployment,
} from "../curve-composite";
import { isDexMeasuredExecutionTargetInLane, isDexMeasuredExecutionTargetScoreEligible } from "../admission";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { fetchEvmBlockHeader, fetchEvmCallHexAtBlock, fetchEvmCodeStatusAtBlock } from "../../../lib/evm-rpc";
import type * as EvmRpcModule from "../../../lib/evm-rpc";
import type { EvmMulticall3Call } from "../../../lib/evm-rpc";
import type { CurvePool } from "../../dex-liquidity/types";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => ({
  ...await importOriginal<typeof EvmRpcModule>(),
  fetchEvmBlockHeader: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEvmCodeStatusAtBlock: vi.fn(),
}));

const blockNumber = Number(captured.rpcSource.block.number);
const blockHash = captured.rpcSource.block.hash as `0x${string}`;
const blockTimestamp = Date.parse(captured.rpcSource.block.timestamp) / 1_000;
const observedAt = Math.floor(Date.parse(captured.quotes[0].observedAt) / 1_000);
const codes: Record<string, string> = captured.codeByAddress;
const calls = new Map(captured.calls.map((call) => [`${call.target}:${call.callData}`, call.returnData]));
const quotes = new Map(captured.quotes.map((quote) => [quote.callData, quote.returnData]));
const quoteAbi = parseAbi(["function get_dy_underlying(int128,int128,uint256) view returns(uint256)"]);
// Preserve raw capture strings in the fixture; these unused display fields
// satisfy the legacy Curve transport type, not executable amount arithmetic.
const sourcePool: CurvePool = {
  ...captured.curveSource.poolData,
  totalSupply: Number(captured.curveSource.poolData.totalSupply),
  gaugeCrvApy: [captured.curveSource.poolData.gaugeCrvApy[0], captured.curveSource.poolData.gaugeCrvApy[1]],
};

function references() {
  return {
    chainAddressToId: new Map(policy.executionTokens.flatMap((token) =>
      token.trackedAssetId ? [[`ethereum:${token.address}`, token.trackedAssetId] as const] : [])),
    stablecoinPriceById: new Map(captured.inputReferences.map((reference) => [reference.id, reference.price])),
  };
}

async function targetFromCapturedSource() {
  const refs = references();
  const lookups = await buildCurveLookups(
    CURVE_CHAINS.map((chain) => chain === "ethereum" ? {
      observedAt: Math.floor(captured.curveSource.generatedTimeMs / 1_000),
      data: { poolData: [sourcePool] },
    } : null),
    new Map([["HOME", [policy.stablecoinId]]]),
    new Map([["HOME", new Map([["ethereum", [policy.stablecoinId]]])]]),
    refs.chainAddressToId,
  );
  const curveData = lookups.curvePoolMap.get(`ethereum:${policy.poolAddress}`);
  return {
    curveData,
    target: buildCurveCompositeMeasuredExecutionTarget({
      curveData,
      chain: "ethereum",
      stablecoinId: policy.stablecoinId,
      ...refs,
      retainedTvlUsd: curveData!.metapoolAdjustedTvl,
      capturedAt: Math.floor(captured.curveSource.generatedTimeMs / 1_000),
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // The fixture contains numbered raw reads. This backend exercises the
  // verifier's finalized-header contract; it is not a production finality receipt.
  vi.mocked(fetchEvmBlockHeader).mockResolvedValue({ number: blockNumber, hash: blockHash, timestamp: blockTimestamp });
  vi.mocked(fetchEvmCodeStatusAtBlock).mockImplementation(async (_chain, address, block) => {
    expect(block).toBe(blockNumber);
    const code = codes[address.toLowerCase()];
    return code ? { status: "available", code: code as `0x${string}` } : { status: "unavailable" };
  });
  vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data, block) => {
    expect(block).toBe(blockNumber);
    return (calls.get(`${address.toLowerCase()}:${data.toLowerCase()}`) as `0x${string}` | undefined) ?? null;
  });
});

describe("captured HOME Curve underlying shadow producer", () => {
  it("retains the exact source identity and verifies the six-decimal implementation, not the legacy template", async () => {
    expect(shouldRetainCurveCompositePoolIdentity("ethereum", policy.poolAddress)).toBe(true);
    const { curveData, target } = await targetFromCapturedSource();
    expect(curveData?.poolCoins?.map((token) => token.decimals)).toEqual([6, 18]);
    expect(curveData?.underlyingCoins?.map((token) => token.decimals)).toEqual([6, 18, 6, 6]);
    expect(DexMeasuredExecutionTargetSchema.safeParse(target).success).toBe(true);
    expect(target).toMatchObject({ tokenIn: { decimals: 6, trackedAssetId: "home-homecoin" }, tokenOut: { decimals: 6, trackedAssetId: "usdc-circle" } });
    expect(keccak256(codes[policy.poolAddress] as `0x${string}`)).toBe(policy.expectedPoolCodeHash);
    expect(keccak256(codes[policy.implementationAddress] as `0x${string}`)).toBe(policy.expectedImplementationCodeHash);
    const verified = await verifyCurveCompositeDeployment({ policy, nowSec: observedAt, chainRpcs: new Map() });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.proof).toMatchObject({ blockNumber, blockHash, poolIndex: 123, implementationAddress: "0x213be373fdff327658139c7df330817dad2d5bbe" });
    expect(isDexMeasuredExecutionTargetInLane(target!, "shadow")).toBe(true);
    expect(isDexMeasuredExecutionTargetInLane(target!, "active")).toBe(false);
    expect(isDexMeasuredExecutionTargetScoreEligible(target!)).toBe(false);
  });

  it("quotes the captured USD-sized 0-to-2 underlying requests and emits only non-scoring evidence", async () => {
    const { target } = await targetFromCapturedSource();
    expect(target).not.toBeNull();
    const verified = await verifyCurveCompositeDeployment({ policy, nowSec: observedAt, chainRpcs: new Map() });
    if (!verified.ok) throw new Error(verified.reason);
    const executeMulticall = vi.fn(async ({ calls: batch, blockNumber: requestedBlock, blockHash: requestedHash }: {
      calls: readonly EvmMulticall3Call[];
      blockNumber: number;
      blockHash: `0x${string}`;
    }) => {
      expect(requestedBlock).toBe(blockNumber);
      expect(requestedHash).toBe(blockHash);
      return batch.map((call) => {
        const decoded = decodeFunctionData({ abi: quoteAbi, data: call.callData as `0x${string}` });
        expect(decoded.functionName).toBe("get_dy_underlying");
        expect(decoded.args.slice(0, 2)).toEqual([0n, 2n]);
        const returnData = quotes.get(call.callData);
        if (!returnData) throw new Error("Uncaptured quote requested");
        return { label: call.label, success: true, returnData: returnData as `0x${string}` };
      });
    });
    const outcomes = await createCurveCompositeQuoteExecutor({ executeMulticall })({
      requests: captured.quotes.map((quote) => ({
        target: target!, inputUsd: quote.inputUsd, blockNumber, blockHash,
        blockObservedAt: observedAt, endpointAddress: policy.poolAddress,
        runtimeEvidence: verified.runtimeEvidence,
      })),
      chainRpcs: new Map(),
    });
    const points = outcomes.map((outcome, index) => {
      expect(outcome.point).toBeDefined();
      expect(outcome.point?.amountInRaw).toBe(captured.quotes[index].amountInRaw);
      expect(outcome.point?.amountOutRaw).toBe(BigInt(captured.quotes[index].returnData).toString());
      expect(outcome.point?.passesCostBound).toBe(false);
      return outcome.point!;
    });
    const profile = buildDexMeasuredExecutionProfile({
      target: target!, targetGenerationId: "home-shadow-targets-fixture", quoteGenerationId: "home-shadow-quotes-fixture",
      quotedAt: blockTimestamp, blockNumber, blockHash,
      endpointAddress: policy.poolAddress, endpointCodeHash: verified.codeHash,
      curveCompositeProof: verified.proof, points,
    });
    expect(validateCurveCompositeProfileProof(profile)).toEqual([]);
    expect(profile.capacityCurve.every((point) => point.executableUsd === 0)).toBe(true);
    const publicProfile = toDexMeasuredExecutionPublicProfile(profile);
    expect(publicProfile).not.toHaveProperty("curveCompositeProof");
    expect(publicProfile.curveCompositeProvenance?.blockHash).toBe(blockHash);
    expect(validateMeasuredExecutionProfile(publicProfile, {
      stablecoinId: policy.stablecoinId, observedAt,
      pool: { poolId: target!.poolId, project: "curve", chain: "ethereum", tvlUsd: target!.retainedTvlUsd, symbol: "HOME / 3Crv", poolType: "curve-stableswap", source: "dl", extra: { measuredExecutionPhysicalPoolId: target!.poolId } },
    })).toContain("adapter-not-score-eligible");
  });

  it.each(["runtime", "implementation", "underlying-decimals", "missing-base-call", "reorg"] as const)("fails closed on %s evidence", async (fault) => {
    if (fault === "runtime" || fault === "implementation") {
      const badAddress = fault === "runtime" ? policy.poolAddress : policy.implementationAddress;
      vi.mocked(fetchEvmCodeStatusAtBlock).mockImplementation(async (_chain, address) => ({
        status: "available", code: address.toLowerCase() === badAddress ? "0x00" : codes[address.toLowerCase()] as `0x${string}`,
      }));
    }
    if (fault === "underlying-decimals" || fault === "missing-base-call") {
      const broken = captured.calls.find((call) => call.label === (fault === "underlying-decimals" ? "factory-underlying-decimals" : "factory-base-pool"))!;
      vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, address, data) => {
        if (address.toLowerCase() === broken.target && data.toLowerCase() === broken.callData) return fault === "missing-base-call" ? null : "0x";
        return (calls.get(`${address.toLowerCase()}:${data.toLowerCase()}`) as `0x${string}` | undefined) ?? null;
      });
    }
    if (fault === "reorg") vi.mocked(fetchEvmBlockHeader)
      .mockResolvedValueOnce({ number: blockNumber, hash: blockHash, timestamp: blockTimestamp })
      .mockResolvedValueOnce({ number: blockNumber, hash: `0x${"ab".repeat(32)}`, timestamp: blockTimestamp });
    expect((await verifyCurveCompositeDeployment({ policy, nowSec: observedAt, chainRpcs: new Map() })).ok).toBe(false);
  });

  it("requires independent current endpoint references and the complete underlying identity", async () => {
    const { curveData } = await targetFromCapturedSource();
    const refs = references();
    refs.stablecoinPriceById.delete("home-homecoin");
    expect(buildCurveCompositeMeasuredExecutionTarget({ curveData, chain: "ethereum", stablecoinId: policy.stablecoinId, ...refs, retainedTvlUsd: 1_000, capturedAt: observedAt })).toBeNull();
    expect(buildCurveCompositeMeasuredExecutionTarget({ curveData: { ...curveData!, underlyingCoins: [...curveData!.underlyingCoins!].reverse() }, chain: "ethereum", stablecoinId: policy.stablecoinId, ...references(), retainedTvlUsd: 1_000, capturedAt: observedAt })).toBeNull();
  });
});
