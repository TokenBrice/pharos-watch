import { describe, expect, it, vi } from "vitest";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";

import { canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import { DexAmmExecutionModelSchema } from "@shared/types/market";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import {
  buildAmmCapacityCurve,
  validateAmmExecutionModel,
  trackedExactAmmOutputValuationFields,
} from "@shared/lib/p4-exit-route-amm-simulation";
import {
  getDexExecutionCapabilityRegistration,
  isDexExecutionProfileAdmittedForScoring,
} from "@shared/lib/p4-exit-route-capability-policy";
import { buildPoolFingerprint, initSourcePoolGraph } from "../pool-helpers";
import {
  EVM_V2_EXECUTION_DEPLOYMENTS,
  attachEvmV2CandidateToRetainedPool,
  buildEvmV2ExecutionCandidate,
  enrichEvmV2ExecutionModels,
  refreshUsdaV2Price,
} from "../constant-product-v2";
import {
  EVM_V2_REPLAY_BLOCK,
  EVM_V2_REPLAY_CASES,
  EVM_V2_RETAINED_TVL_USD,
  addressWord as fixtureAddressWord,
  buildReviewedV2Profile,
  replayTarget,
} from "./fixtures/evm-v2-fixtures";
import { captureRpcs, word, addressWord, reservesWord, blockHeader, makeCandidate, makeAerodromeCandidate, runV2PriceLegScenario, targetForReplay, runReplay } from "./constant-product-v2.test-support";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import type { EvmRpcOptions } from "../../../lib/evm-rpc";

const U = "0xce24439f2d9c6a2289f741120fe202248b666666" as const;
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as const;
const PAIR = "0x108752b2a22c731ede3edac2205c63ae553e221a" as const;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;
const AERODROME_PAIR = "0xcdac0d6c6c59727a65f871236188350531885c43" as const;
const A7A5 = "0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9" as const;
const USDT_ETHEREUM = "0xdac17f958d2ee523a2206206994597c13d831ec7" as const;
const A7A5_USDT_PAIR = "0x14d7aab5b4bca6a02e52ac22520b033bf35f4091" as const;
const SPUSD = "0x40ff3dea2eec93a7b71879874dc4407918da77a6" as const;
const USDC_BSC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" as const;
const SPUSD_USDC_PAIR = "0x1111111111111111111111111111111111111111" as const;
const KAG = "0x56ba8b58b7d1f6d384a1c4dd553f39ebc8741b8e" as const;
const XAUT = "0x68749665ff8d2d112fa859aa293f07a622782f38" as const;

function captureContext(metric: ReturnType<typeof initSourcePoolGraph>) {
  return { nowSec: 1_700_000_000, sourceGenerationId: "dex-stage:fixture", metrics: new Map([[metric.stablecoinId, metric]]),
    contractMetaByChainAddress: new Map(), chainRpcs: captureRpcs("bsc", "BSC") };
}

function captureDependencies(fetchMulticall: unknown, codeHash: `0x${string}`, block = 50_000_000) {
  return {
    fetchBlockNumber: vi.fn(async () => block),
    fetchBlockHeader: vi.fn(async (_chain: string, number: number | "finalized") => blockHeader(number as number)),
    fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
    fetchMulticall: fetchMulticall as never,
    hashCode: vi.fn(() => codeHash),
  };
}

const U5_REPLAY_ASSET_IDS = new Set(["idrt-rupiah-token", "stusd-stoneyield"]);

describe("constant-product V2 execution", () => {
  it("admits only the reviewed V2 families", () => {
    expect(makeCandidate()).toMatchObject({ source: "pancakeswap-v2", poolAddress: PAIR });
    expect(makeAerodromeCandidate()).toMatchObject({ source: "solidly-v2", poolAddress: AERODROME_PAIR });
    const pancake = { chain: "bsc", protocol: "pancakeswap-v2-bsc", poolType: "ds-amm", poolAddress: PAIR, tokenAddresses: [U, WBNB] };
    const aero = { chain: "base", protocol: "aerodrome", poolType: "aerodrome-volatile", poolAddress: AERODROME_PAIR, tokenAddresses: [USDC_BASE, WETH_BASE] };
    for (const input of [
      { ...pancake, poolType: "cg-cl-30bp" },
      { ...pancake, protocol: "pancakeswap-v3", poolType: "gt-concentrated" },
      { ...aero, chain: "avalanche" },
    ]) expect(buildEvmV2ExecutionCandidate(input)).toBeNull();
    for (const [input, expected] of [
      [pancake, { source: "pancakeswap-v2" }],
      [{ chain: "ethereum", protocol: "uniswap-v2", poolType: "generic", poolAddress: A7A5_USDT_PAIR, tokenAddresses: [A7A5, USDT_ETHEREUM] }, { source: "uniswap-v2" }],
      [aero, { source: "solidly-v2", solidlyProtocol: "aerodrome" }],
      [{ ...aero, poolType: "aerodrome-stable" }, { source: "solidly-v2", solidlyProtocol: "aerodrome" }],
    ] as const) expect(buildEvmV2ExecutionCandidate(input)).toMatchObject(expected);
  });

  it("transfers an exact staged candidate onto a retained DL fingerprint", () => {
    const candidate = makeCandidate();
    const metric = initSourcePoolGraph("u-united-stables", "U");
    metric.pools.push({
      poolId: buildPoolFingerprint("bsc", "pancakeswap", [U, WBNB])!,
      project: "pancakeswap",
      chain: "BSC",
      tvlUsd: 2_000_000,
      symbol: "U-WBNB",
      volumeUsd1d: 100_000,
      poolType: "generic",
      source: "dl",
      extra: {},
    });
    const metrics = new Map([[metric.stablecoinId, metric]]);

    expect(
      attachEvmV2CandidateToRetainedPool({
        metrics,
        stablecoinId: metric.stablecoinId,
        chain: "bsc",
        candidate,
      }),
    ).toBe(true);
    expect(metric.pools[0]!.extra?.evmV2ExecutionCandidate).toEqual(candidate);
  });

  it("keeps conflicting fingerprint candidates unresolved in either arrival order", () => {
    const first = makeCandidate();
    const second = { ...first, poolAddress: "0x0000000000000000000000000000000000005bad" as const };
    for (const candidates of [[first, second], [second, first]]) {
      const metric = initSourcePoolGraph("u-united-stables", "U");
      metric.pools.push({
        poolId: buildPoolFingerprint("bsc", "pancakeswap", [U, WBNB])!,
        project: "pancakeswap", chain: "BSC", tvlUsd: 2_000_000,
        symbol: "U-WBNB", volumeUsd1d: 100_000, poolType: "generic", source: "dl", extra: {},
      });
      const metrics = new Map([[metric.stablecoinId, metric]]);
      expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate: candidates[0]! })).toBe(true);
      // A repeated source row for the same physical candidate is harmless.
      expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate: candidates[0]! })).toBe(true);
      expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate: candidates[1]! })).toBe(false);
      expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate: candidates[0]! })).toBe(false);
      expect(metric.pools[0]!.extra?.evmV2ExecutionCandidate).toBeUndefined();
      expect(metric.pools[0]!.extra?.executionCapabilityGate).toEqual({
        family: "constant-product-v2", reason: "exact-pool-join-unresolved",
      });
    }
  });

  it("prefers an exact physical row and refuses non-unique fingerprint joins", () => {
    const candidate = makeCandidate();
    const metric = initSourcePoolGraph("u-united-stables", "U");
    const fingerprintPool = {
      poolId: buildPoolFingerprint("bsc", "pancakeswap", [U, WBNB])!,
      project: "pancakeswap", chain: "BSC", tvlUsd: 2_000_000,
      symbol: "U-WBNB", volumeUsd1d: 100_000, poolType: "generic", source: "dl" as const,
    };
    metric.pools.push({ ...fingerprintPool }, { ...fingerprintPool });
    const metrics = new Map([[metric.stablecoinId, metric]]);
    expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate })).toBe(false);
    metric.pools.push({ ...fingerprintPool, poolId: canonicalExitRouteAssetKey("bsc", PAIR) });
    expect(attachEvmV2CandidateToRetainedPool({ metrics, stablecoinId: metric.stablecoinId, chain: "bsc", candidate })).toBe(true);
    expect(metric.pools[2]!.extra?.evmV2ExecutionCandidate).toEqual(candidate);
    expect(metric.pools[0]!.extra?.evmV2ExecutionCandidate).toBeUndefined();
  });

  it("builds a same-block Pancake V2 model after factory and pair verification", async () => {
    const candidate = makeCandidate();
    const metric = initSourcePoolGraph("u-united-stables", "U");
    metric.pools.push({
      poolId: buildPoolFingerprint("bsc", "pancakeswap", [U, WBNB])!,
      project: "pancakeswap",
      chain: "BSC",
      tvlUsd: 2_000_000,
      symbol: "U-WBNB",
      volumeUsd1d: 100_000,
      poolType: "ds-amm",
      source: "dexscreener",
      extra: { evmV2ExecutionCandidate: candidate },
    });
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "pancakeswap-v2")!;
    const fetchMulticall = vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
      calls.map((call) => ({
        label: call.label,
        success: true,
        returnData: call.label.endsWith("-pair")
          ? addressWord(PAIR)
          : call.label.endsWith("-token0")
            ? addressWord(U)
            : call.label.endsWith("-token1")
              ? addressWord(WBNB)
              : call.label.endsWith("-reserves")
                ? reservesWord(1_000_000n * 10n ** 18n, 2_000n * 10n ** 18n)
                : word(18n),
      })),
    );

    await enrichEvmV2ExecutionModels({
      ...captureContext(metric),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("bsc", U), metric.stablecoinId]]),
      contractMetaByChainAddress: new Map([
        [
          canonicalExitRouteAssetKey("bsc", U),
          { stablecoinId: metric.stablecoinId, symbol: "U", decimals: 18, source: "contract" },
        ],
      ]),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      dependencies: captureDependencies(fetchMulticall, deployment.expectedFactoryCodeHash),
    });

    const retained = metric.pools[0]!;
    expect(retained.poolId).toBe(`bsc:${PAIR}`);
    expect(retained.extra?.evmV2ExecutionCandidate).toBeUndefined();
    expect(retained.extra?.ammExecutionModel).toMatchObject({
      source: "pancakeswap-v2",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.0025,
      tokens: [
        { address: U, balance: 1_000_000, referencePriceUsd: 1, referencePriceSource: "tracked-market" },
        { address: WBNB, balance: 2_000, referencePriceUsd: 500, referencePriceSource: "pool-implied" },
      ],
    });
    expect(fetchMulticall).toHaveBeenCalledOnce();
  });

  it("pins the BSC multicall to the authenticated finalized head on a recent-only Dwellir route", async () => {
    const finalized = {
      number: 49_999_940,
      timestamp: 1_699_999_940,
      hash: `0x${"ab".repeat(32)}` as `0x${string}`,
    };
    const candidate = makeCandidate();
    const metric = initSourcePoolGraph("u-united-stables", "U");
    metric.pools.push({
      poolId: buildPoolFingerprint("bsc", "pancakeswap", [U, WBNB])!,
      project: "pancakeswap",
      chain: "BSC",
      tvlUsd: 2_000_000,
      symbol: "U-WBNB",
      volumeUsd1d: 100_000,
      poolType: "ds-amm",
      source: "dexscreener",
      extra: { evmV2ExecutionCandidate: candidate },
    });
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "pancakeswap-v2")!;
    const chainRpcs: Map<string, ChainRpcConfig> = new Map([["bsc", {
      chainId: "bsc",
      chainName: "BSC",
      type: "evm",
      explorerUrl: "https://explorer.example",
      endpoints: [
        { url: "https://bsc-dwellir.example", operator: "dwellir", keyed: true, position: "registry", stateHistory: "recent", logsHistory: "full" },
        { url: "https://bsc-archive.example", operator: "alchemy", keyed: true, position: "registry", stateHistory: "archive", logsHistory: "full" },
      ],
    }]]);
    const fetchBlockNumber = vi.fn(async () => 50_000_000);
    const fetchBlockHeader = vi.fn(async (_chain: string, blockNumberOrTag: number | "finalized") =>
      blockNumberOrTag === "finalized" ? finalized : finalized);
    const fetchCodeAtBlock = vi.fn(async (
      _chain: string | undefined,
      _address: string,
      _blockNumber?: number | "latest",
      _options?: EvmRpcOptions,
    ) => "0x6000" as const);
    const fetchMulticall = vi.fn(async (
      _chain: string,
      calls: readonly { label: string }[],
      _blockNumber: number,
      _options?: EvmRpcOptions,
    ) => calls.map((call) => ({
      label: call.label,
      success: true,
      returnData: call.label.endsWith("-pair")
        ? addressWord(PAIR)
        : call.label.endsWith("-token0")
          ? addressWord(U)
          : call.label.endsWith("-token1")
            ? addressWord(WBNB)
            : call.label.endsWith("-reserves")
              ? reservesWord(1_000_000n * 10n ** 18n, 2_000n * 10n ** 18n)
              : word(18n),
    })));

    await enrichEvmV2ExecutionModels({
      ...captureContext(metric),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("bsc", U), metric.stablecoinId]]),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      chainRpcs,
      dependencies: {
        fetchBlockNumber,
        fetchBlockHeader,
        fetchCodeAtBlock,
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
    });

    expect(fetchBlockNumber).not.toHaveBeenCalled();
    expect(metric.pools[0]!.extra?.ammExecutionModel).toMatchObject({
      source: "pancakeswap-v2",
      capture: { blockNumber: finalized.number, blockHash: finalized.hash, blockTimestamp: finalized.timestamp },
    });
    expect(fetchCodeAtBlock.mock.calls[0]![2]).toBe(finalized.number);
    expect((fetchCodeAtBlock.mock.calls[0]![3] as EvmRpcOptions).recentStatePin).toMatchObject({
      chainId: "bsc", header: finalized, finalized,
    });
    expect(fetchMulticall.mock.calls[0]![2]).toBe(finalized.number);
    expect((fetchMulticall.mock.calls[0]![3] as EvmRpcOptions).recentStatePin).toMatchObject({
      chainId: "bsc", header: finalized, finalized,
    });
  });

  it("implies the tracked V2 input from a unique authoritative counter-asset", async () => {
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "uniswap-v2")!;
    const chainAddressToId = new Map([
      [canonicalExitRouteAssetKey("ethereum", A7A5), "a7a5-old-vector"],
      [canonicalExitRouteAssetKey("ethereum", USDT_ETHEREUM), "usdt-tether"],
    ]);
    const chainRpcs = captureRpcs("ethereum", "Ethereum");
    const fetchMulticall = vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
      calls.map((call) => ({
        label: call.label,
        success: true,
        returnData: call.label.endsWith("-pair")
          ? addressWord(A7A5_USDT_PAIR)
          : call.label.endsWith("-token0")
            ? addressWord(A7A5)
            : call.label.endsWith("-token1")
              ? addressWord(USDT_ETHEREUM)
              : call.label.endsWith("-reserves")
                ? reservesWord(5_700_000n * 10n ** 6n, 71_000n * 10n ** 6n)
                : word(6n),
      })),
    );
    const enrich = async (stablecoinPriceById: Map<string, number>) => {
      const candidate = buildEvmV2ExecutionCandidate({
        chain: "ethereum",
        protocol: "uniswap-v2",
        poolType: "generic",
        poolAddress: A7A5_USDT_PAIR,
        tokenAddresses: [A7A5, USDT_ETHEREUM],
        tokenSymbols: ["A7A5", "USDT"],
      })!;
      const metric = initSourcePoolGraph("a7a5-old-vector", "A7A5");
      metric.pools.push({
        poolId: canonicalExitRouteAssetKey("ethereum", A7A5_USDT_PAIR),
        project: "uniswap-v2",
        chain: "Ethereum",
        tvlUsd: 71_058,
        symbol: "A7A5-USDT",
        volumeUsd1d: 12_000,
        poolType: "generic",
        source: "dexscreener",
        extra: { evmV2ExecutionCandidate: candidate },
      });
      await enrichEvmV2ExecutionModels({
        ...captureContext(metric),
        chainAddressToId,
          stablecoinPriceById,
        chainRpcs: chainRpcs as never,
        dependencies: captureDependencies(fetchMulticall, deployment.expectedFactoryCodeHash, 21_000_000),
      });
      return metric.pools[0]!;
    };

    const unpriced = await enrich(new Map());
    expect(unpriced.extra?.ammExecutionModel).toBeUndefined();
    expect(unpriced.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "incomplete-exact-capture",
    });

    const implied = await enrich(new Map([["usdt-tether", 1]]));
    expect(implied.extra?.executionCapabilityGate).toBeUndefined();
    expect(implied.extra?.ammExecutionModel).toMatchObject({
      source: "uniswap-v2",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.003,
      tokens: [
        {
          address: A7A5,
          trackedAssetId: "a7a5-old-vector",
          referencePriceUsd: 71_000 / 5_700_000,
          referencePriceSource: "pool-implied",
        },
        {
          address: USDT_ETHEREUM,
          trackedAssetId: "usdt-tether",
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
        },
      ],
    });

    const trusted = await enrich(
      new Map([
        ["a7a5-old-vector", 0.0125],
        ["usdt-tether", 1],
      ]),
    );
    expect(trusted.extra?.executionCapabilityGate).toBeUndefined();
    expect(trusted.extra?.ammExecutionModel).toMatchObject({
      source: "uniswap-v2",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.003,
      tokens: [
        { address: A7A5, referencePriceUsd: 0.0125, referencePriceSource: "tracked-market" },
        { address: USDT_ETHEREUM, referencePriceUsd: 1, referencePriceSource: "tracked-market" },
      ],
    });
  });

  it("implies a Pancake V2 tracked input from USDC when the wrapper quote is untrusted", async () => {
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "pancakeswap-v2")!;
    const candidate = buildEvmV2ExecutionCandidate({
      chain: "bsc",
      protocol: "pancakeswap",
      poolType: "ds-amm",
      poolAddress: SPUSD_USDC_PAIR,
      tokenAddresses: [SPUSD, USDC_BSC],
      tokenSymbols: ["SPUSD", "USDC"],
    })!;
    const metric = initSourcePoolGraph("spusd-soulpeg", "SPUSD");
    metric.pools.push({
      poolId: canonicalExitRouteAssetKey("bsc", SPUSD_USDC_PAIR),
      project: "pancakeswap",
      chain: "BSC",
      tvlUsd: 8_854,
      symbol: "SPUSD / USDC",
      volumeUsd1d: 1_200,
      poolType: "cg-amm",
      source: "cg_onchain",
      extra: { evmV2ExecutionCandidate: candidate },
    });
    await enrichEvmV2ExecutionModels({
      ...captureContext(metric),
      chainAddressToId: new Map([
        [canonicalExitRouteAssetKey("bsc", SPUSD), "spusd-soulpeg"],
        [canonicalExitRouteAssetKey("bsc", USDC_BSC), "usdc-circle"],
      ]),
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 50_000_000),
        fetchBlockHeader: vi.fn(async (_chain: string, blockNumber: number | "finalized") =>
          blockHeader(blockNumber as number)),
        fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
        fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
          calls.map((call) => ({
            label: call.label,
            success: true,
            returnData: call.label.endsWith("-pair")
              ? addressWord(SPUSD_USDC_PAIR)
              : call.label.endsWith("-token0")
                ? addressWord(SPUSD)
                : call.label.endsWith("-token1")
                  ? addressWord(USDC_BSC)
                  : call.label.endsWith("-reserves")
                    ? reservesWord(4_430n * 10n ** 18n, 4_420n * 10n ** 18n)
                    : word(18n),
          })),
        ) as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
    });

    expect(metric.pools[0]!.extra?.executionCapabilityGate).toBeUndefined();
    expect(metric.pools[0]!.extra?.ammExecutionModel).toMatchObject({
      source: "pancakeswap-v2",
      invariant: "constant-product",
      trackedTokenIndex: 0,
      feeRate: 0.0025,
      tokens: [
        {
          address: SPUSD,
          trackedAssetId: "spusd-soulpeg",
          referencePriceUsd: 4_420 / 4_430,
          referencePriceSource: "pool-implied",
        },
        {
          address: USDC_BSC,
          trackedAssetId: "usdc-circle",
          referencePriceUsd: 1,
          referencePriceSource: "tracked-market",
        },
      ],
    });
  });

  it("implies KAG from XAUt on a factory-verified Ethereum Uni V2 pair", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([
        [canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"],
        [canonicalExitRouteAssetKey("ethereum", XAUT), "xaut-tether"],
      ]),
      stablecoinPriceById: new Map([["xaut-tether", 4_300]]),
    });

    expect(metric.pools[0]!.extra?.executionCapabilityGate).toBeUndefined();
    expect(metric.pools[0]!.extra?.ammExecutionModel).toMatchObject({
      source: "uniswap-v2",
      trackedTokenIndex: 0,
      tokens: [
        { address: KAG, referencePriceSource: "pool-implied", referencePriceUsd: (1 * 4_300) / 14 },
        { address: XAUT, referencePriceSource: "tracked-market", referencePriceUsd: 4_300 },
      ],
    });
  });

  it("scales reversed V2 candidates by their actual pair-token identities", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([
        [canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"],
        [canonicalExitRouteAssetKey("ethereum", XAUT), "xaut-tether"],
      ]),
      stablecoinPriceById: new Map([["xaut-tether", 4_300]]),
      candidateTokenAddresses: [XAUT, KAG],
      candidateTokenSymbols: ["XAUt", "KAG"],
      candidateDecimals0: 6n,
      candidateDecimals1: 18n,
    });

    const model = DexAmmExecutionModelSchema.parse(metric.pools[0]!.extra?.ammExecutionModel);
    expect(model).toMatchObject({
      source: "uniswap-v2",
      trackedTokenIndex: 0,
      tokens: [
        { address: KAG, decimals: 18, balance: 14 },
        { address: XAUT, decimals: 6, balance: 1 },
      ],
    });
    const curve = buildAmmCapacityCurve(model!, 1);
    expect(curve.map((point) => point.executableUsd)).toEqual([74.82, 74.82, 74.82, 74.82]);
  });

  it("still gates a captured V2 pair when no token has a trusted quote leg", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"]]),
      stablecoinPriceById: new Map(),
    });

    expect(metric.pools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.pools[0]!.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "incomplete-exact-capture",
    });
  });

  it("does not replace a missing tracked output reference with a reserve-implied value", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([
        [canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"],
        [canonicalExitRouteAssetKey("ethereum", XAUT), "xaut-tether"],
      ]),
      stablecoinPriceById: new Map([["kag-kinesis", 75]]),
    });
    expect(metric.pools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.pools[0]!.extra?.executionCapabilityGate?.reason).toBe("incomplete-exact-capture");
  });

  it("keeps an untracked pool-implied output distinct from an independent USD reference", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"]]),
      stablecoinPriceById: new Map([["kag-kinesis", 75]]),
    });
    const output = metric.pools[0]!.extra?.ammExecutionModel?.tokens[1];
    expect(output?.referencePriceSource).toBe("pool-implied");
    expect(trackedExactAmmOutputValuationFields(output!, "test-reference", 1_700_000_000)).toEqual({});
  });

  it("bounds deployment probes so one oversized request cannot gate every V2 pool", async () => {
    const metric = initSourcePoolGraph("u-united-stables", "U");
    const candidates = Array.from({ length: 5 }, (_, index) => {
      const poolAddress = `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`;
      const candidate = buildEvmV2ExecutionCandidate({
        chain: "bsc",
        protocol: "pancakeswap",
        poolType: "ds-amm",
        poolAddress,
        tokenAddresses: [U, WBNB],
        tokenSymbols: ["U", "WBNB"],
      })!;
      metric.pools.push({
        poolId: poolAddress,
        project: "pancakeswap",
        chain: "BSC",
        tvlUsd: 2_000_000,
        symbol: "U-WBNB",
        volumeUsd1d: 100_000,
        poolType: "ds-amm",
        source: "dexscreener",
        extra: { evmV2ExecutionCandidate: candidate },
      });
      return candidate;
    });
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "pancakeswap-v2")!;
    const fetchMulticall = vi.fn(async (_chain: string, calls: readonly { label: string }[]) => {
      if (calls.length > 24) return null;
      return calls.map((call) => {
        const index = Number(call.label.match(/^v2-(\d+)-/)?.[1]);
        return {
          label: call.label,
          success: true,
          returnData: call.label.endsWith("-pair")
            ? addressWord(candidates[index]!.poolAddress)
            : call.label.endsWith("-token0")
              ? addressWord(U)
              : call.label.endsWith("-token1")
                ? addressWord(WBNB)
                : call.label.endsWith("-reserves")
                  ? reservesWord(1_000_000n * 10n ** 18n, 2_000n * 10n ** 18n)
                  : word(18n),
        };
      });
    });

    await enrichEvmV2ExecutionModels({
      ...captureContext(metric),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("bsc", U), metric.stablecoinId]]),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      dependencies: captureDependencies(fetchMulticall, deployment.expectedFactoryCodeHash),
    });

    expect(fetchMulticall).toHaveBeenCalledTimes(2);
    expect(fetchMulticall.mock.calls.map((call) => call[1].length)).toEqual([24, 6]);
    expect(metric.pools.every((pool) => pool.extra?.ammExecutionModel?.source === "pancakeswap-v2")).toBe(true);
  });

  it("fails closed when the canonical factory runtime does not match", async () => {
    const metric = initSourcePoolGraph("u-united-stables", "U");
    metric.pools.push({
      poolId: `bsc:${PAIR}`,
      project: "pancakeswap",
      chain: "BSC",
      tvlUsd: 2_000_000,
      symbol: "U-WBNB",
      volumeUsd1d: 100_000,
      poolType: "ds-amm",
      source: "dexscreener",
      extra: { evmV2ExecutionCandidate: makeCandidate() },
    });
    const fetchMulticall = vi.fn();

    await enrichEvmV2ExecutionModels({
      ...captureContext(metric),
      chainAddressToId: new Map(),
      stablecoinPriceById: new Map(),
      dependencies: captureDependencies(fetchMulticall, `0x${"00".repeat(32)}` as `0x${string}`),
    });

    expect(metric.pools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.pools[0]!.extra?.evmV2ExecutionCandidate).toBeUndefined();
    expect(metric.pools[0]!.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "deployment-code-mismatch",
    });
    expect(fetchMulticall).not.toHaveBeenCalled();
  });

  it.each([
    1_700_000_000 - DEX_MEASURED_FRESHNESS_MAX_SEC - 1,
    1_700_000_000 + 61,
  ])("withholds exact V2 capture at an expired or future header %s", async (headerTimestamp) => {
    const result = await runReplay(EVM_V2_REPLAY_CASES[0]!, { headerTimestamp });
    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2", reason: "stale-observation",
    });
    expect(result.fetchMulticall).not.toHaveBeenCalled();
  });

  for (const replay of EVM_V2_REPLAY_CASES.filter((entry) => U5_REPLAY_ASSET_IDS.has(entry.assetId))) {
    it(`replays the exact U5 tuple and complete V2 curve for ${replay.assetId}`, async () => {
      const result = await runReplay(replay);
      const retained = result.metric.pools[0]!;
      const model = DexAmmExecutionModelSchema.parse(retained.extra?.ammExecutionModel);
      const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
        (entry) => entry.source === "pancakeswap-v2",
      )!;

      expect(retained.poolId).toBe(`bsc:${replay.poolAddress}`);
      expect(retained.extra?.executionCapabilityGate).toBeUndefined();
      expect(model).toBeDefined();
      expect(model.capture).toEqual({
        blockNumber: EVM_V2_REPLAY_BLOCK, blockHash: `0x${"ab".repeat(32)}`,
        blockTimestamp: 1_700_000_000, sourceGenerationId: "dex-stage:fixture",
      });
      expect(model.tokens.every((token) =>
        token.referencePriceSourceId === "stablecoins-cache:fixture" &&
        token.referencePriceObservedAt === 1_699_999_880,
      )).toBe(true);
      expect(validateAmmExecutionModel(model!, {
        chain: "bsc",
        stablecoinId: replay.assetId,
        retainedTvlUsd: EVM_V2_RETAINED_TVL_USD,
        nowSec: 1_700_000_000,
      })).toEqual([]);
      expect(model!.feeRate).toBe(0.0025);
      expect(model!.trackedTokenIndex).toBe(
        replay.pairTokenOrder === "stable-first" ? 0 : 1,
      );
      expect(model!.tokens.map((token) => ({
        address: token.address,
        decimals: token.decimals,
        balance: token.balance,
      }))).toEqual(
        replay.pairTokenOrder === "stable-first"
          ? [
              {
                address: replay.stablecoinAddress,
                decimals: replay.stablecoinDecimals,
                balance: EVM_V2_RETAINED_TVL_USD / 2,
              },
              {
                address: replay.counterAddress,
                decimals: replay.counterDecimals,
                balance: EVM_V2_RETAINED_TVL_USD / 2,
              },
            ]
          : [
              {
                address: replay.counterAddress,
                decimals: replay.counterDecimals,
                balance: EVM_V2_RETAINED_TVL_USD / 2,
              },
              {
                address: replay.stablecoinAddress,
                decimals: replay.stablecoinDecimals,
                balance: EVM_V2_RETAINED_TVL_USD / 2,
              },
            ],
      );

      const outputTokenIndex = model!.trackedTokenIndex === 0 ? 1 : 0;
      const curve = buildAmmCapacityCurve(model!, outputTokenIndex);
      expect(curve).toHaveLength(4);
      expect(curve.every((point) =>
        point.executableUsd === point.requestedNotionalUsd &&
        point.completionRatio === 1 &&
        point.executionCostBps != null &&
        point.executionCostBps <= 200,
      )).toBe(true);

      expect(result.fetchBlockNumber).toHaveBeenCalledOnce();
      expect(result.fetchCodeAtBlock).toHaveBeenCalledWith(
        "bsc",
        deployment.factoryAddress,
        EVM_V2_REPLAY_BLOCK,
        expect.any(Object),
      );
      expect(result.fetchMulticall).toHaveBeenCalledOnce();
      expect(result.fetchMulticall.mock.calls[0]![2]).toBe(EVM_V2_REPLAY_BLOCK);
      expect(result.fetchMulticall.mock.calls[0]![1]).toHaveLength(6);

      const target = targetForReplay(replay);
      expect(target).toEqual(replayTarget(replay));
      expect(target.feePips).toBe(2_500);
      expect(target.tokenIn.trackedAssetId).toBe(replay.assetId);
      expect(target.tokenOut.trackedAssetId).toBe(replay.counterAssetId);
      const reviewed = buildReviewedV2Profile({ replay, model: model!, target });
      expect(reviewed.capacityCurve).toEqual(curve);
      expect(reviewed.profile.capacityCurve.every((point) =>
        point.executableUsd === point.requestedNotionalUsd && point.completionRatio === 1,
      )).toBe(true);
      expect(reviewed.profile.quoteProof).toHaveLength(5);

      const registration = getDexExecutionCapabilityRegistration("evm-v2-constant-product-v1");
      expect(registration).not.toBeNull();
      expect(isDexExecutionProfileAdmittedForScoring(reviewed.profile, registration!)).toBe(true);
    });
  }

  it.each([
    ["rejects a factory result bound to a different pair address", 1, "pair", fixtureAddressWord("0x0000000000000000000000000000000000005bad"), "exact-pool-join-unresolved"],
    ["rejects a pair whose token identity is not the staged counter-asset pair", 2, "token0", fixtureAddressWord("0x0000000000000000000000000000000000005bad"), "ambiguous-token-identity"],
    ["rejects a malformed reserve snapshot instead of producing partial depth", 3, "reserves", `${reservesWord(2_000_000_000n * 10n ** 18n, 2_000_000_000n * 10n ** 18n)}00`, "incomplete-exact-capture"],
    ["distinguishes observed zero reserves from a failed reserve read", 0, "reserves", reservesWord(0n, 1n), "invalid-invariant-parameters"],
  ] as const)("%s", async (_name, index, suffix, returnData, reason) => {
    const result = await runReplay(EVM_V2_REPLAY_CASES[index]!, {
      mutateResults: (results) => { results.find((row) => row.label.endsWith(`-${suffix}`))!.returnData = returnData; },
    });
    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({ family: "constant-product-v2", reason });
  });

  for (const suffix of ["decimals0", "decimals1", "reserves"]) {
    it(`retains a missing ${suffix} read as unavailable, never zero`, async () => {
      const result = await runReplay(EVM_V2_REPLAY_CASES[0]!, {
        mutateResults: (results) => {
          const entry = results.find((row) => row.label.endsWith(`-${suffix}`))!;
          entry.success = false;
          entry.returnData = "0x";
        },
      });
      expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
      expect(result.pool.extra?.executionCapabilityGate).toEqual({
        family: "constant-product-v2", reason: "incomplete-exact-capture",
      });
    });
  }

  it("discards a complete reserve batch when its pinned header reorganizes", async () => {
    const result = await runReplay(EVM_V2_REPLAY_CASES[0]!, { reorgOnConfirmation: true });
    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2", reason: "transport-unavailable",
    });
  });

  it("does not reuse a stale reserve batch when the pinned block changes", async () => {
    const replay = EVM_V2_REPLAY_CASES[4]!;
    const result = await runReplay(replay, {
      blockNumber: EVM_V2_REPLAY_BLOCK + 1,
      serveOnlyBlock: EVM_V2_REPLAY_BLOCK,
    });

    expect(result.fetchMulticall.mock.calls[0]![2]).toBe(EVM_V2_REPLAY_BLOCK + 1);
    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "transport-unavailable",
    });
  });

  it.each(["observed", "stale-parent", "future-parent", "implied-parent", "wrong-pool", "old-generation", "missing-capture", "thin"])("USDA native reserve price: %s", async (scenario) => {
    const result = await runReplay({ ...EVM_V2_REPLAY_CASES[4]!,
      poolAddress: "0xde66f1b24002c1d743ad1ef13cd4b2474295a6f6", pairTokenOrder: "stable-first" });
    const model = DexAmmExecutionModelSchema.parse(result.pool.extra?.ammExecutionModel);
    result.pool.extra!.ammExecutionModel = model;
    const quote = model.tokens[1]!;
    quote.referencePriceUsd = 0.998;
    if (scenario === "stale-parent") quote.referencePriceObservedAt = 1_700_000_000 - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC;
    if (scenario === "future-parent") quote.referencePriceObservedAt = 1_700_000_001;
    if (scenario === "implied-parent") quote.referencePriceSource = "pool-implied";
    if (scenario === "wrong-pool") result.pool.poolId = `bsc:${PAIR}`;
    if (scenario === "old-generation") model.capture!.sourceGenerationId = "previous";
    if (scenario === "missing-capture") delete model.capture;
    if (scenario === "thin") result.pool.tvlUsd = 49_999;
    const before = { ...result.pool };
    const observed = refreshUsdaV2Price(captureContext(result.metric));
    if (scenario === "observed") {
      expect(observed).toEqual({ status: "observed", priceUsd: 0.998, supportUsd: 3_992_000_000, observedAt: 1_699_999_880 });
      expect(result.pool).toMatchObject({ price: 0.998, priceSource: "direct_api", priceEvidenceTvlUsd: 3_992_000_000 });
    } else {
      expect(observed.status).toBe("unavailable");
      expect(result.pool).toEqual(before);
    }
  });
});
