import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, parseAbiParameters } from "viem/utils";
import { buildChainRpcs } from "../../../lib/chain-registry";

import type {
  DexMeasuredExecutionProfile,
  DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  buildDexMeasuredExecutionProfile,
  createDexMeasuredExecutionRpcBudget,
} from "../profiles";
import {
  CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
  CURVE_CRYPTOSWAP_REVIEWED_COHORT,
  createCurveCryptoSwapQuoteExecutor,
  decodeCurveCryptoSwapGetDy,
  decodeCurveCryptoSwapQuotePoint,
  encodeCurveCryptoSwapGetDy,
  evaluateCurveCryptoSwapEligibility,
  getCurveCryptoSwapReviewedDeploymentFamily,
  getCurveCryptoSwapReviewedPolicy,
  resolveCurveCryptoSwapTokenIndices,
  validateCurveCryptoSwapProfileProof,
  verifyCurveCryptoSwapDeployment,
  type CurveCryptoSwapPoolPolicy,
} from "../curve-cryptoswap";
import { isOperationalDexMeasuredFailure } from "../persistence";
import { makeMeasuredTarget } from "@shared/test-utils/measured-execution.test-support";
import { makeCurveQuoteRequests } from "./measured-execution.test-support";

const ETHEREUM_BLOCK = 25_536_894;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CADD = "0x16f93ebc5320c89efc8701577efe49d14a276a06";
const CRVUSD = "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CRV = "0xd533a949740bb3306d119cc777fa900ba034cd52";
const TWOCRYPTO_POOL = "0x4fdccb810f22578ad6700fc10a8c9b6c1df61852";
const ACTIVE_TWOCRYPTO_POOL = "0x313698667d7fdd6789a9bc70821309ff891e729a";
const TRICRYPTO_POOL = "0x4ebdf703948ddcea3b11f675b4d1fba9d2414a14";
const HASH_A = `0x${"11".repeat(32)}` as `0x${string}`;
const HASH_B = `0x${"22".repeat(32)}` as `0x${string}`;
const HASH_C = `0x${"33".repeat(32)}` as `0x${string}`;
const HASH_D = `0x${"44".repeat(32)}` as `0x${string}`;
const DEP_A = "0x0000000000000000000000000000000000000011";
const DEP_B = "0x0000000000000000000000000000000000000022";
const DEP_C = "0x0000000000000000000000000000000000000033";

function uint256Word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function uint256Return(value: bigint): `0x${string}` {
  return `0x${uint256Word(value)}`;
}

function makeTarget(
  input: {
    poolAddress?: `0x${string}`;
    chain?: string;
    stablecoinId?: string;
    poolTokenAddresses?: `0x${string}`[];
    inputIndex?: number;
    outputIndex?: number;
    inputDecimals?: number;
    outputDecimals?: number;
    inputPrice?: number;
    outputPrice?: number;
    poolId?: string;
  } = {},
): DexMeasuredExecutionTarget {
  const poolAddress = input.poolAddress ?? TWOCRYPTO_POOL;
  const chain = input.chain ?? "ethereum";
  const poolTokenAddresses = input.poolTokenAddresses ?? [CADD, USDC];
  const inputIndex = input.inputIndex ?? 0;
  const outputIndex = input.outputIndex ?? 1;
  const poolId = input.poolId ?? `${chain}:${poolAddress}`;
  const stablecoinId = input.stablecoinId ?? "cadd";
  const tokenIn = {
    address: poolTokenAddresses[inputIndex]!,
    symbol: "INPUT",
    decimals: input.inputDecimals ?? 18,
    referencePriceUsd: input.inputPrice ?? 1,
    trackedAssetId: stablecoinId,
  };
  const tokenOut = {
    address: poolTokenAddresses[outputIndex]!,
    symbol: "OUTPUT",
    decimals: input.outputDecimals ?? 6,
    referencePriceUsd: input.outputPrice ?? 1,
    trackedAssetId: "output-asset",
  };
  return makeMeasuredTarget({
    stablecoinId,
    adapterProfileId: CURVE_CRYPTOSWAP_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain,
    poolId,
    poolTokenAddresses,
    tokenIn,
    tokenOut,
    retainedTvlUsd: 1_000_000,
    retainedPoolPriceUsd: tokenIn.referencePriceUsd,
    capturedAt: 1_752_500_000,
  });
}

function completePinnedPolicy(): CurveCryptoSwapPoolPolicy {
  return {
    chain: "ethereum",
    poolAddress: TWOCRYPTO_POOL,
    generation: "twocrypto-ng",
    identityAnchor: "pinned-pool-code",
    expectedPoolCodeHash: HASH_A,
    expectedFactoryAddress: DEP_A,
    expectedFactoryCodeHash: HASH_B,
    expectedViewsAddress: DEP_B,
    expectedViewsCodeHash: HASH_C,
    expectedMathAddress: DEP_C,
    expectedMathCodeHash: HASH_D,
    transferSemanticsReviewed: false,
  };
}

function completeRuntimeEvidence() {
  return {
    apiIsBroken: false,
    poolCodeHash: HASH_A,
    factoryAddress: DEP_A,
    factoryCodeHash: HASH_B,
    viewsAddress: DEP_B,
    viewsCodeHash: HASH_C,
    mathAddress: DEP_C,
    mathCodeHash: HASH_D,
    ngKillMethodUnavailable: true,
    transferSemanticsReviewed: true,
  } as const;
}

describe("Curve CryptoSwap policy", () => {
  it("pins the nineteen reviewed active Ethereum TwoCrypto pools", () => {
    expect(CURVE_CRYPTOSWAP_REVIEWED_COHORT).toHaveLength(19);
    expect(CURVE_CRYPTOSWAP_REVIEWED_COHORT.every((entry) => entry.generation === "twocrypto-ng")).toBe(true);
    const active = CURVE_CRYPTOSWAP_REVIEWED_COHORT;
    expect(active.every((entry) => entry.transferSemanticsReviewed)).toBe(true);
    const pinned = active.filter((entry) => entry.identityAnchor === "pinned-pool-code");
    expect(pinned).toHaveLength(8);
    expect(
      pinned.every(
        (entry) =>
          entry.expectedPoolCodeHash != null &&
          entry.expectedFactoryCodeHash != null &&
          entry.expectedViewsCodeHash != null &&
          entry.expectedMathCodeHash != null,
      ),
    ).toBe(true);
    // R3 (2026-07-29) promoted the reviewed Ethereum TwoCrypto census; no other
    // chain or generation has a reviewed family, so nothing else can ride it.
    const familyAnchored = active.filter((entry) => entry.identityAnchor === "reviewed-deployment-family");
    expect(familyAnchored).toHaveLength(11);
    expect(getCurveCryptoSwapReviewedDeploymentFamily("ethereum", "twocrypto-ng")?.mathDeployments).toEqual(
      expect.arrayContaining([
        {
          address: "0x2005995a71243be9fb995dab4742327dc76564df",
          codeHash: "0xbc931b24ccca3aae2cd24bf83022386ae21d4c96af2f7c7f57a91c743b8352e3",
        },
        {
          address: "0x1fd8af16dc4bebd950521308d55d0543b6cdf4a1",
          codeHash: "0x70d105ee0e9b857244d87521bbcef34cfb4cbd600592af61bbc7c76180648d61",
        },
      ]),
    );
    expect(
      familyAnchored.every(
        (entry) =>
          entry.chain === "ethereum" &&
          entry.generation === "twocrypto-ng" &&
          entry.expectedPoolCodeHash == null &&
          getCurveCryptoSwapReviewedDeploymentFamily(entry.chain, entry.generation) != null,
      ),
    ).toBe(true);
  });

  it("keeps every pinned active pool inside its reviewed deployment family", () => {
    // The family allowlist and the per-pool pins are separate literals; they
    // must not drift apart, or a family-anchored pool would accept a factory,
    // views, or math deployment no pinned pool ever proved.
    for (const entry of CURVE_CRYPTOSWAP_REVIEWED_COHORT) {
      if (entry.identityAnchor !== "pinned-pool-code") continue;
      const family = getCurveCryptoSwapReviewedDeploymentFamily(entry.chain, entry.generation);
      expect(family).not.toBeNull();
      expect(entry.expectedFactoryAddress).toBe(family!.factoryAddress);
      expect(entry.expectedFactoryCodeHash).toBe(family!.factoryCodeHash);
      expect(entry.expectedViewsAddress).toBe(family!.viewsAddress);
      expect(entry.expectedViewsCodeHash).toBe(family!.viewsCodeHash);
      expect(
        family!.mathDeployments.some(
          (math) => math.address === entry.expectedMathAddress && math.codeHash === entry.expectedMathCodeHash,
        ),
      ).toBe(true);
    }
  });

  it("admits a family-anchored pool on the reviewed dependency triple alone", () => {
    const policy = CURVE_CRYPTOSWAP_REVIEWED_COHORT.find(
      (entry) => entry.identityAnchor === "reviewed-deployment-family",
    );
    if (!policy) throw new Error("missing family-anchored Curve CryptoSwap policy");
    const family = getCurveCryptoSwapReviewedDeploymentFamily(policy.chain, policy.generation)!;
    const evidence = {
      apiIsBroken: false,
      // Per-pool bytecode is recorded, never pre-pinned: Curve NG bakes
      // constructor immutables into each pool's runtime code.
      poolCodeHash: HASH_A,
      factoryAddress: family.factoryAddress,
      factoryCodeHash: family.factoryCodeHash,
      viewsAddress: family.viewsAddress,
      viewsCodeHash: family.viewsCodeHash,
      mathAddress: family.mathDeployments[1]!.address,
      mathCodeHash: family.mathDeployments[1]!.codeHash,
      ngKillMethodUnavailable: true,
      transferSemanticsReviewed: true,
      onChainPoolTokenAddresses: [CRVUSD, WETH] as `0x${string}`[],
    };
    const evaluate = (overrides: Partial<typeof evidence>) =>
      evaluateCurveCryptoSwapEligibility({
        chain: policy.chain,
        endpointAddress: policy.poolAddress,
        policy,
        evidence: { ...evidence, ...overrides },
      });

    expect(evaluate({})).toEqual({ ok: true });
    // Any runtime code hash is accepted for the pool itself, but the read must
    // have succeeded.
    expect(evaluate({ poolCodeHash: HASH_B })).toEqual({ ok: true });
    expect(evaluate({ poolCodeHash: undefined })).toEqual({ ok: false, reason: "runtime-code-unavailable" });
    // The dependency triple stays exact.
    expect(evaluate({ factoryAddress: DEP_A })).toEqual({ ok: false, reason: "dependency-identity-mismatch" });
    expect(evaluate({ viewsAddress: DEP_B })).toEqual({ ok: false, reason: "dependency-identity-mismatch" });
    expect(evaluate({ mathAddress: DEP_C })).toEqual({ ok: false, reason: "dependency-identity-mismatch" });
    expect(evaluate({ factoryCodeHash: HASH_B })).toEqual({ ok: false, reason: "dependency-code-hash-mismatch" });
    expect(evaluate({ viewsCodeHash: HASH_C })).toEqual({ ok: false, reason: "dependency-code-hash-mismatch" });
    // A reviewed math address paired with the other deployment's hash fails.
    expect(evaluate({ mathCodeHash: family.mathDeployments[0]!.codeHash })).toEqual({
      ok: false,
      reason: "dependency-code-hash-mismatch",
    });
    expect(evaluate({ ngKillMethodUnavailable: false })).toEqual({
      ok: false,
      reason: "ng-kill-method-not-proven-absent",
    });
    expect(evaluate({ transferSemanticsReviewed: false })).toEqual({
      ok: false,
      reason: "transfer-semantics-unreviewed",
    });
    expect(evaluate({ onChainPoolTokenAddresses: [CRVUSD] })).toEqual({
      ok: false,
      reason: "pool-token-order-unverified",
    });
  });

  it("admits a reviewed active policy only with complete matching runtime evidence", () => {
    const policy = CURVE_CRYPTOSWAP_REVIEWED_COHORT.find((entry) => entry.identityAnchor === "pinned-pool-code");
    if (!policy) throw new Error("missing active Curve CryptoSwap policy");
    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: policy.chain,
        endpointAddress: policy.poolAddress,
        policy,
        evidence: {
          apiIsBroken: false,
          poolCodeHash: policy.expectedPoolCodeHash,
          factoryAddress: policy.expectedFactoryAddress,
          factoryCodeHash: policy.expectedFactoryCodeHash,
          viewsAddress: policy.expectedViewsAddress,
          viewsCodeHash: policy.expectedViewsCodeHash,
          mathAddress: policy.expectedMathAddress,
          mathCodeHash: policy.expectedMathCodeHash,
          ngKillMethodUnavailable: true,
          transferSemanticsReviewed: true,
          onChainPoolTokenAddresses: [CRVUSD, WETH],
        },
      }),
    ).toEqual({ ok: true });
  });

  it("fails closed across API pause, kill, runtime, dependency, and activation gates", () => {
    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TWOCRYPTO_POOL,
      }),
    ).toEqual({ ok: false, reason: "api-broken-or-unknown" });

    // A family-anchored pool has a complete allowlist, so an unread runtime is
    // reported as an unavailable read rather than a missing review.
    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TWOCRYPTO_POOL,
        evidence: { apiIsBroken: false, ngKillMethodUnavailable: true },
      }),
    ).toEqual({ ok: false, reason: "runtime-code-unavailable" });

    // A pinned policy with no pinned hashes keeps the incomplete-allowlist gate.
    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TRICRYPTO_POOL,
        policy: {
          chain: "ethereum",
          poolAddress: TRICRYPTO_POOL,
          generation: "twocrypto-ng",
          identityAnchor: "pinned-pool-code",
          transferSemanticsReviewed: true,
        },
        evidence: { apiIsBroken: false, ngKillMethodUnavailable: true },
      }),
    ).toEqual({ ok: false, reason: "runtime-allowlist-incomplete" });


    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TWOCRYPTO_POOL,
        policy: completePinnedPolicy(),
        evidence: { ...completeRuntimeEvidence(), poolCodeHash: HASH_B },
      }),
    ).toEqual({ ok: false, reason: "runtime-code-hash-mismatch" });

    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TWOCRYPTO_POOL,
        policy: completePinnedPolicy(),
        evidence: { ...completeRuntimeEvidence(), viewsAddress: DEP_C },
      }),
    ).toEqual({ ok: false, reason: "dependency-identity-mismatch" });

    expect(
      evaluateCurveCryptoSwapEligibility({
        chain: "ethereum",
        endpointAddress: TWOCRYPTO_POOL,
        policy: completePinnedPolicy(),
        evidence: completeRuntimeEvidence(),
      }),
    ).toEqual({ ok: false, reason: "transfer-semantics-unreviewed" });
  });
});

describe("Curve CryptoSwap hash-bound kill-proof acquisition", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const dependencyAbi = parseAbi([
    "function factory() view returns (address)",
    "function MATH() view returns (address)",
    "function views_implementation() view returns (address)",
    "function coins(uint256) view returns (address)",
  ]);
  const aggregateAbi = parseAbi([
    "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
  ]);
  const codeHash = keccak256("0x6000");
  const policy: CurveCryptoSwapPoolPolicy = {
    ...completePinnedPolicy(), transferSemanticsReviewed: true,
    expectedPoolCodeHash: codeHash, expectedFactoryCodeHash: codeHash,
    expectedViewsCodeHash: codeHash, expectedMathCodeHash: codeHash,
  };
  const response = (result: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const aggregateResult = (success: boolean, returnData: `0x${string}` = "0x") =>
    encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [[{ success, returnData }]]);

  it.each([
    ["executed refusal", false, "0x", true, null],
    ["successful empty getter", true, "0x", false, "ng-kill-method-not-proven-absent"],
    ["successful false getter", true, uint256Return(0n), false, "ng-kill-method-not-proven-absent"],
    ["successful true getter", true, uint256Return(1n), false, "ng-kill-method-not-proven-absent"],
    ["HTTP503", null, null, false, "ng-kill-probe-unavailable"],
    ["timeout", null, null, false, "ng-kill-probe-unavailable"],
    ["admission denial", null, null, false, "ng-kill-probe-unavailable"],
    ["malformed aggregate", null, "0x1234", false, "ng-kill-probe-unavailable"],
    ["missing member", null, "0x", false, "ng-kill-probe-unavailable"],
  ] as const)("%s never confuses outer failure with executed method absence", async (mode, success, data, ok, reason) => {
    const chainRpcs = buildChainRpcs("alchemy-test-key");
    const config = chainRpcs.get("ethereum")!;
    config.endpoints = config.endpoints.filter((endpoint) => endpoint.operator === "alchemy").slice(0, 1);
    const rpcBudget = createDexMeasuredExecutionRpcBudget({
      maxRequests: mode === "admission denial" ? 9 : 20, deadlineMs: Date.now() + 60_000,
    });
    let killCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.params[1]).toEqual({ blockHash: HASH_A, requireCanonical: true });
      if (request.method === "eth_getCode") return response("0x6000");
      expect(request.method).toBe("eth_call");
      const callData = request.params[0].data as `0x${string}`;
      if (callData.startsWith("0x82ad56cb")) {
        killCalls++;
        const decoded = decodeFunctionData({ abi: aggregateAbi, data: callData });
        expect(decoded.args[0].map((call) => ({ ...call, target: call.target.toLowerCase() }))).toEqual([{
          target: policy.poolAddress.toLowerCase(), allowFailure: true, callData: "0x9c868ac0",
        }]);
        if (mode === "HTTP503") return new Response("unavailable", { status: 503 });
        if (mode === "timeout") throw new DOMException("RPC timeout", "TimeoutError");
        if (mode === "malformed aggregate") return response(data!);
        if (mode === "missing member") return response(encodeAbiParameters(parseAbiParameters("(bool success,bytes returnData)[]"), [[]]));
        return response(aggregateResult(success!, data as `0x${string}`));
      }
      const decoded = decodeFunctionData({ abi: dependencyAbi, data: callData });
      const address = decoded.functionName === "factory" ? DEP_A
        : decoded.functionName === "MATH" ? DEP_C
        : decoded.functionName === "views_implementation" ? DEP_B
        : decoded.args[0] === 0n ? CADD : USDC;
      return response(encodeFunctionResult({ abi: dependencyAbi, functionName: decoded.functionName, result: address }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await verifyCurveCryptoSwapDeployment({
      policy, blockNumber: ETHEREUM_BLOCK, blockHash: HASH_A, chainRpcs, rpcBudget,
    });
    expect(result.ok).toBe(ok);
    if (result.ok) expect(result.runtimeEvidence.ngKillMethodUnavailable).toBe(true);
    else expect(result.reason).toBe(reason);
    expect(killCalls).toBe(mode === "admission denial" ? 0 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(mode === "admission denial" ? 9 : 10);
    expect(rpcBudget.requestsUsed).toBe(fetchMock.mock.calls.length);
    expect(isOperationalDexMeasuredFailure(reason)).toBe(reason === "ng-kill-probe-unavailable");
  });

  it("refuses unsupported hash state without trying a numeric selector", async () => {
    const chainRpcs = buildChainRpcs("alchemy-test-key");
    const config = chainRpcs.get("ethereum")!;
    config.endpoints = config.endpoints.filter((endpoint) => endpoint.operator === "alchemy").slice(0, 1);
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).params[1]).toEqual({ blockHash: HASH_A, requireCanonical: true });
      return new Response(JSON.stringify({ error: { code: -32000, message: "hash not canonical" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(verifyCurveCryptoSwapDeployment({
      policy, blockNumber: ETHEREUM_BLOCK, blockHash: HASH_A, chainRpcs,
    })).resolves.toEqual({ ok: false, reason: "runtime-code-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Curve CryptoSwap token indices and ABI", () => {
  it("uses ordered 2-8 token inventory while keeping route poolId separate from execution address", () => {
    const target = makeTarget({
      poolTokenAddresses: [CRVUSD, WETH, CRV],
      inputIndex: 0,
      outputIndex: 2,
      poolAddress: TRICRYPTO_POOL,
      poolId: "ethereum:defillama-route-fingerprint-not-an-address",
    });
    expect(resolveCurveCryptoSwapTokenIndices(target)).toEqual({ ok: true, inputIndex: 0, outputIndex: 2 });
    expect(getCurveCryptoSwapReviewedPolicy(target.chain, TWOCRYPTO_POOL)?.poolAddress).toBe(TWOCRYPTO_POOL);
    expect(target.poolId).not.toContain(TRICRYPTO_POOL);

    expect(
      resolveCurveCryptoSwapTokenIndices(
        makeTarget({
          poolTokenAddresses: [CADD, USDC, CADD],
          inputIndex: 0,
          outputIndex: 1,
        }),
      ),
    ).toEqual({ ok: false, reason: "ambiguous-token-index" });
    expect(
      resolveCurveCryptoSwapTokenIndices({
        ...makeTarget(),
        poolTokenAddresses: undefined,
      }),
    ).toEqual({ ok: false, reason: "missing-pool-token-order" });
  });

  it.each([
    { amountInRaw: 1n, amountOutRaw: 1n },
    { amountInRaw: (1n << 256n) - 1n, amountOutRaw: (1n << 256n) - 1n },
  ])("encodes and decodes uint256 ABI boundaries: $amountInRaw", ({ amountInRaw, amountOutRaw }) => {
    const callData = encodeCurveCryptoSwapGetDy({ inputIndex: 0, outputIndex: 1, amountInRaw });
    expect(callData).toBe(`0x556d6e9f${uint256Word(0n)}${uint256Word(1n)}${uint256Word(amountInRaw)}`);
    expect(decodeCurveCryptoSwapGetDy(uint256Return(amountOutRaw))).toBe(amountOutRaw);
  });

  it("rejects zero input while decoding a zero output", () => {
    expect(() => encodeCurveCryptoSwapGetDy({ inputIndex: 0, outputIndex: 1, amountInRaw: 0n })).toThrow();
    expect(decodeCurveCryptoSwapGetDy(uint256Return(0n))).toBe(0n);
  });
});

describe("Curve CryptoSwap quote transport", () => {
  it("quotes the physical pool endpoint and persists exact raw proof", async () => {
    const target = makeTarget({ poolId: "ethereum:defillama-route-fingerprint-not-an-address" });
    const executeMulticall = vi.fn(async (_input: unknown) => [
      {
        label: `0:${target.targetId}`,
        success: true,
        returnData: uint256Return(999_000_000n),
      },
    ]);
    const quote = createCurveCryptoSwapQuoteExecutor({ executeMulticall });
    const outcomes = await quote({
      requests: [
        {
          target,
          inputUsd: 1_000,
          blockNumber: ETHEREUM_BLOCK,
          blockHash: HASH_A,
          endpointAddress: TWOCRYPTO_POOL,
          runtimeEvidence: { apiIsBroken: false, ngKillMethodUnavailable: true },
        },
      ],
      chainRpcs: new Map(),
    });

    expect(executeMulticall).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "ethereum",
        blockNumber: ETHEREUM_BLOCK,
        blockHash: HASH_A,
        calls: [expect.objectContaining({ target: TWOCRYPTO_POOL, allowFailure: true })],
      }),
    );
    expect(outcomes[0]).toMatchObject({
      eligibility: { ok: false, reason: "runtime-code-unavailable" },
      point: {
        amountInRaw: "1000000000000000000000",
        amountOutRaw: "999000000",
        inputUsd: 1_000,
        outputUsd: 999,
        passesCostBound: true,
        adapterMetadata: {
          executionPool: TWOCRYPTO_POOL,
          inputIndex: 0,
          outputIndex: 1,
          shadow: false,
        },
      },
    });
  });

  it("preserves the Curve adaptive multicall golden split", async () => {
    const sizes: number[] = [];
    const executeMulticall = vi.fn(async (input: { calls: readonly { label: string }[] }) => {
      sizes.push(input.calls.length);
      if (input.calls.length === 8) return null;
      return input.calls.map((call) => ({ label: call.label, success: true, returnData: uint256Return(0n) }));
    });
    const quote = createCurveCryptoSwapQuoteExecutor({ executeMulticall });
    const target = makeTarget();
    const outcomes = await quote({
      requests: makeCurveQuoteRequests(target, TWOCRYPTO_POOL, ETHEREUM_BLOCK, 9),
      chainRpcs: new Map(),
    });

    expect(sizes).toEqual([8, 4, 4, 1]);
    expect(outcomes).toHaveLength(9);
    expect(outcomes.every((outcome) => outcome.point?.amountOutRaw === "0")).toBe(true);
  });

  it("preserves the Curve adaptive multicall golden unattempted result", async () => {
    const sizes: number[] = [];
    const executeMulticall = vi.fn(async (input: { calls: readonly { label: string }[] }) => {
      sizes.push(input.calls.length);
      return null;
    });
    const quote = createCurveCryptoSwapQuoteExecutor({ executeMulticall });
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 100,
      deadlineMs: Date.now() + 60_000,
    });

    const outcomes = await quote({
      requests: makeCurveQuoteRequests(
        makeTarget(),
        TWOCRYPTO_POOL,
        ETHEREUM_BLOCK,
        4,
        () => 1_000,
      ),
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(sizes).toEqual([4, 2]);
    expect(budget.openChains).toEqual(["ethereum"]);
    expect(outcomes.map((outcome) => outcome.failureReason)).toEqual([
      "rpc-failure",
      "rpc-failure",
      "rpc-failure",
      "rpc-failure",
    ]);
    expect(outcomes.every((outcome) => isOperationalDexMeasuredFailure(outcome.failureReason))).toBe(true);
  });

  it("does not relabel a genuine pool revert from an already stopped budget", async () => {
    const executeMulticall = vi.fn(async (input: { calls: readonly { label: string }[] }) =>
      input.calls.map((call) => ({ label: call.label, success: false, returnData: "0x" as const })),
    );
    const quote = createCurveCryptoSwapQuoteExecutor({ executeMulticall });
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 0,
      deadlineMs: Date.now() + 60_000,
    });
    expect(budget.tryConsume()).toBe(false);

    const outcomes = await quote({
      requests: makeCurveQuoteRequests(makeTarget(), TWOCRYPTO_POOL, ETHEREUM_BLOCK, 1),
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(outcomes[0]?.failureReason).toBe("pool-revert");
    expect(isOperationalDexMeasuredFailure(outcomes[0]?.failureReason)).toBe(false);
  });

  it("rejects active quotes when provider token order disagrees with on-chain coins", async () => {
    const policy = getCurveCryptoSwapReviewedPolicy("ethereum", ACTIVE_TWOCRYPTO_POOL);
    if (policy == null) throw new Error("missing active Curve CryptoSwap policy");
    const executeMulticall = vi.fn(async () => [
      {
        label: "unused",
        success: true,
        returnData: uint256Return(1n),
      },
    ]);
    const quote = createCurveCryptoSwapQuoteExecutor({ executeMulticall });
    const target = makeTarget({
      poolAddress: ACTIVE_TWOCRYPTO_POOL,
      poolTokenAddresses: [WETH, CRVUSD],
      inputIndex: 1,
      outputIndex: 0,
      inputDecimals: 18,
      outputDecimals: 18,
    });
    const outcomes = await quote({
      requests: [
        {
          target,
          inputUsd: 1_000,
          blockNumber: ETHEREUM_BLOCK,
          blockHash: HASH_A,
          endpointAddress: ACTIVE_TWOCRYPTO_POOL,
          runtimeEvidence: {
            apiIsBroken: false,
            poolCodeHash: policy.expectedPoolCodeHash,
            factoryAddress: policy.expectedFactoryAddress,
            factoryCodeHash: policy.expectedFactoryCodeHash,
            viewsAddress: policy.expectedViewsAddress,
            viewsCodeHash: policy.expectedViewsCodeHash,
            mathAddress: policy.expectedMathAddress,
            mathCodeHash: policy.expectedMathCodeHash,
            ngKillMethodUnavailable: true,
            transferSemanticsReviewed: true,
            onChainPoolTokenAddresses: [CRVUSD, WETH],
          },
        },
      ],
      chainRpcs: new Map(),
    });

    expect(executeMulticall).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({
      eligibility: { ok: true },
      failureReason: "pool-token-order-mismatch",
    });
  });

});

describe("Curve CryptoSwap stored proof validation", () => {
  function makeProfile(target = makeTarget()): DexMeasuredExecutionProfile {
    const policy = getCurveCryptoSwapReviewedPolicy("ethereum", TWOCRYPTO_POOL);
    if (policy == null) throw new Error("missing TwoCrypto policy fixture");
    const amountInRaw = 1_000n * 10n ** 18n;
    const decoded = decodeCurveCryptoSwapQuotePoint(
      {
        target,
        policy,
        endpointAddress: TWOCRYPTO_POOL,
        blockNumber: ETHEREUM_BLOCK,
        inputIndex: 0,
        outputIndex: 1,
        amountInRaw,
        callData: encodeCurveCryptoSwapGetDy({ inputIndex: 0, outputIndex: 1, amountInRaw }),
      },
      {
        label: "marginal",
        success: true,
        returnData: uint256Return(1_000_000_000n),
      },
    );
    if (decoded.point == null) throw new Error("missing quote point fixture");
    return buildDexMeasuredExecutionProfile({
      blockHash: HASH_A,
      target,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: target.capturedAt + 60,
      blockNumber: ETHEREUM_BLOCK,
      endpointAddress: TWOCRYPTO_POOL,
      endpointCodeHash: HASH_A,
      points: [decoded.point],
    });
  }

  it("accepts exact calldata and return data without equating route poolId to the endpoint", () => {
    const profile = makeProfile(makeTarget({ poolId: "ethereum:defillama-route-fingerprint-not-an-address" }));
    expect(profile.poolId).toBe("ethereum:defillama-route-fingerprint-not-an-address");
    expect(profile.executionEndpoint.address).toBe(TWOCRYPTO_POOL);
    expect(validateCurveCryptoSwapProfileProof(profile)).toEqual([]);
  });

  it("rejects index and raw return mismatches", () => {
    const profile = makeProfile();
    const wrongIndex = {
      ...profile,
      quoteProof: [
        {
          ...profile.quoteProof[0]!,
          callData: encodeCurveCryptoSwapGetDy({
            inputIndex: 1,
            outputIndex: 0,
            amountInRaw: BigInt(profile.quoteProof[0]!.amountInRaw),
          }),
        },
      ],
    };
    expect(validateCurveCryptoSwapProfileProof(wrongIndex)).toContain("call-data-mismatch");

    const wrongReturn = {
      ...profile,
      quoteProof: [{ ...profile.quoteProof[0]!, amountOutRaw: "999999999" }],
    };
    expect(validateCurveCryptoSwapProfileProof(wrongReturn)).toContain("return-data-mismatch");
  });

  it("binds the endpoint bytecode per identity anchor", () => {
    // TWOCRYPTO_POOL is family-anchored: any readable pool hash is accepted,
    // an unreadable one is not.
    const profile = makeProfile();
    expect(getCurveCryptoSwapReviewedPolicy("ethereum", TWOCRYPTO_POOL)?.identityAnchor).toBe(
      "reviewed-deployment-family",
    );
    expect(
      validateCurveCryptoSwapProfileProof({
        ...profile,
        executionEndpoint: { ...profile.executionEndpoint, codeHash: HASH_B },
      }),
    ).toEqual([]);
    expect(
      validateCurveCryptoSwapProfileProof({
        ...profile,
        executionEndpoint: { ...profile.executionEndpoint, codeHash: "0x" as `0x${string}` },
      }),
    ).toContain("endpoint-code-hash-mismatch");
  });
});
