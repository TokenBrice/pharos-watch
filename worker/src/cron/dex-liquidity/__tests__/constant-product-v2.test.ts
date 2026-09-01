import { describe, expect, it, vi } from "vitest";

import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import {
  buildAmmCapacityCurve,
  validateAmmExecutionModel,
} from "@shared/lib/p4-exit-route-amm-simulation";
import {
  DexExecutionProfileV2Schema,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  getDexExecutionCapabilityRegistration,
  isDexExecutionProfileAdmittedForScoring,
} from "@shared/lib/p4-exit-route-capability-policy";
import { buildPoolFingerprint, initMetrics } from "../pool-helpers";
import { buildEvmV2RegisteredExecutionTarget } from "../execution-targets/evm-v2";
import {
  EVM_V2_EXECUTION_DEPLOYMENTS,
  attachEvmV2CandidateToRetainedPool,
  buildEvmV2ExecutionCandidate,
  buildUniqueEvmV2ExecutionCandidateFingerprintIndex,
  enrichEvmV2ExecutionModels,
  resolveEvmV2ExecutionCandidate,
} from "../constant-product-v2";
import {
  EVM_V2_REPLAY_BLOCK,
  EVM_V2_REPLAY_CASES,
  EVM_V2_RETAINED_TVL_USD,
  addressWord as fixtureAddressWord,
  buildReviewedV2Profile,
  replayCandidate,
  replayMulticallResults,
  replayPool,
  replayTarget,
  type EvmV2ReplayCase,
} from "./fixtures/evm-v2-fixtures";

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
const KAG_XAUT_PAIR = "0x2222222222222222222222222222222222222222" as const;

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function reservesWord(reserve0: bigint, reserve1: bigint): `0x${string}` {
  return `0x${reserve0.toString(16).padStart(64, "0")}${reserve1.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
}

function makeCandidate() {
  return buildEvmV2ExecutionCandidate({
    chain: "bsc",
    protocol: "pancakeswap",
    poolType: "ds-amm",
    poolAddress: PAIR,
    tokenAddresses: [U, WBNB],
    tokenSymbols: ["U", "WBNB"],
  })!;
}

function makeAerodromeCandidate() {
  return buildEvmV2ExecutionCandidate({
    chain: "base",
    protocol: "aerodrome",
    poolType: "aerodrome-volatile",
    poolAddress: AERODROME_PAIR,
    tokenAddresses: [USDC_BASE, WETH_BASE],
    tokenSymbols: ["USDC", "WETH"],
    confirmedStable: false,
  })!;
}

async function runV2PriceLegScenario({
  chainAddressToId,
  stablecoinPriceById,
}: {
  chainAddressToId: Map<string, string>;
  stablecoinPriceById: Map<string, number>;
}) {
  const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "uniswap-v2")!;
  const candidate = buildEvmV2ExecutionCandidate({
    chain: "ethereum",
    protocol: "uniswap-v2",
    poolType: "generic",
    poolAddress: KAG_XAUT_PAIR,
    tokenAddresses: [KAG, XAUT],
    tokenSymbols: ["KAG", "XAUt"],
  })!;
  const metric = initMetrics("kag-kinesis", "KAG");
  metric.topPools.push({
    poolId: canonicalExitRouteAssetKey("ethereum", KAG_XAUT_PAIR),
    project: "uniswap-v2",
    chain: "Ethereum",
    tvlUsd: 1_519,
    symbol: "KAG / XAUt",
    volumeUsd1d: 200,
    poolType: "cg-amm",
    source: "cg_onchain",
    extra: { evmV2ExecutionCandidate: candidate },
  });
  await enrichEvmV2ExecutionModels({
    metrics: new Map([[metric.stablecoinId, metric]]),
    chainAddressToId,
    contractMetaByChainAddress: new Map(),
    stablecoinPriceById,
    chainRpcs: new Map([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example",
          explorerUrl: "https://example.com",
        },
      ],
    ]),
    dependencies: {
      fetchBlockNumber: vi.fn(async () => 21_000_000),
      fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
      fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: call.label.endsWith("-pair")
            ? addressWord(KAG_XAUT_PAIR)
            : call.label.endsWith("-token0")
              ? addressWord(KAG)
              : call.label.endsWith("-token1")
                ? addressWord(XAUT)
                : call.label.endsWith("-reserves")
                  ? reservesWord(14n * 10n ** 18n, 1n * 10n ** 6n)
                  : call.label.endsWith("-decimals0")
                    ? word(18n)
                    : word(6n),
        })),
      ) as never,
      hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
    },
  });
  return metric;
}

function targetForReplay(replay: EvmV2ReplayCase): DexMeasuredExecutionTarget {
  const chainAddressToId = new Map([
    [canonicalExitRouteAssetKey("bsc", replay.stablecoinAddress), replay.assetId],
    [canonicalExitRouteAssetKey("bsc", replay.counterAddress), replay.counterAssetId],
  ]);
  const contractMetaByChainAddress = new Map([
    [
      canonicalExitRouteAssetKey("bsc", replay.stablecoinAddress),
      {
        stablecoinId: replay.assetId,
        symbol: replay.stablecoinSymbol,
        decimals: replay.stablecoinDecimals,
        source: "contract" as const,
      },
    ],
    [
      canonicalExitRouteAssetKey("bsc", replay.counterAddress),
      {
        stablecoinId: replay.counterAssetId,
        symbol: replay.counterSymbol,
        decimals: replay.counterDecimals,
        source: "contract" as const,
      },
    ],
  ]);
  const output = buildEvmV2RegisteredExecutionTarget({
    context: {
      chainAddressToId,
      aerodromeIsStable: new Map(),
      stablecoinPriceById: new Map([
        [replay.assetId, 1],
        [replay.counterAssetId, 1],
      ]),
      measuredTargetCapturedAt: 1_700_000_000,
      contractMetaByChainAddress,
    },
    identity: {
      chainNorm: "bsc",
      protocol: "pancakeswap",
      pool: {
        pool: replay.poolAddress,
        project: "pancakeswap",
        symbol: `${replay.stablecoinSymbol} / ${replay.counterSymbol}`,
        underlyingTokens: [replay.stablecoinAddress, replay.counterAddress],
      },
    },
    enrichment: {
      resolvedPoolType: "cg-amm",
      rawContribTvl: EVM_V2_RETAINED_TVL_USD,
    },
    stablecoinId: replay.assetId,
  } as never);
  const target = output?.measuredExecutionTarget;
  if (!target) throw new Error(`V2 fixture target was not built for ${replay.assetId}`);
  return target;
}

async function runReplay(
  replay: EvmV2ReplayCase,
  options: {
    blockNumber?: number;
    serveOnlyBlock?: number;
    mutateResults?: (results: ReturnType<typeof replayMulticallResults>) => void;
  } = {},
) {
  const candidate = replayCandidate(replay);
  const metric = initMetrics(replay.assetId, replay.stablecoinSymbol);
  const pool = replayPool(replay, candidate);
  metric.topPools.push(pool);
  const chainAddressToId = new Map([
    [canonicalExitRouteAssetKey("bsc", replay.stablecoinAddress), replay.assetId],
    [canonicalExitRouteAssetKey("bsc", replay.counterAddress), replay.counterAssetId],
  ]);
  const contractMetaByChainAddress = new Map([
    [
      canonicalExitRouteAssetKey("bsc", replay.stablecoinAddress),
      {
        stablecoinId: replay.assetId,
        symbol: replay.stablecoinSymbol,
        decimals: replay.stablecoinDecimals,
        source: "contract" as const,
      },
    ],
    [
      canonicalExitRouteAssetKey("bsc", replay.counterAddress),
      {
        stablecoinId: replay.counterAssetId,
        symbol: replay.counterSymbol,
        decimals: replay.counterDecimals,
        source: "contract" as const,
      },
    ],
  ]);
  const pinnedBlock = options.blockNumber ?? EVM_V2_REPLAY_BLOCK;
  const fetchBlockNumber = vi.fn(async () => pinnedBlock);
  const fetchCodeAtBlock = vi.fn(async () => "0x6000" as const);
  const fetchMulticall = vi.fn(
    async (
      _chain: string,
      calls: readonly { label: string; target: string }[],
      blockNumber: number,
    ) => {
      if (options.serveOnlyBlock != null && blockNumber !== options.serveOnlyBlock) return null;
      const results = replayMulticallResults(replay, calls);
      options.mutateResults?.(results);
      return results;
    },
  );
  const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
    (entry) => entry.source === "pancakeswap-v2",
  )!;

  await enrichEvmV2ExecutionModels({
    metrics: new Map([[metric.stablecoinId, metric]]),
    chainAddressToId,
    contractMetaByChainAddress,
    stablecoinPriceById: new Map([
      [replay.assetId, 1],
      [replay.counterAssetId, 1],
    ]),
    chainRpcs: new Map([
      [
        "bsc",
        {
          chainId: "bsc",
          chainName: "BSC",
          type: "evm",
          rpcUrl: "https://rpc.example",
          explorerUrl: "https://example.com",
        },
      ],
    ]),
    dependencies: {
      fetchBlockNumber,
      fetchCodeAtBlock,
      fetchMulticall: fetchMulticall as never,
      hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
    },
  });

  return {
    metric,
    pool,
    candidate,
    fetchBlockNumber,
    fetchCodeAtBlock,
    fetchMulticall,
    contractMetaByChainAddress,
  };
}

const EXPECTED_U5_FACTS = {
  "idrt-rupiah-token": {
    assetId: "idrt-rupiah-token",
    reasonCode: "unsupported-same-notional-route",
    exactFactPath: "exit:unsupported-same-notional-route",
  },
  "spusd-soulpeg": {
    assetId: "spusd-soulpeg",
    reasonCode: "missing-runtime-route-evidence",
    exactFactPath: "gap:exit:local-component:spusd-soulpeg:gap:exit-routes",
  },
  "stusd-stoneyield": {
    assetId: "stusd-stoneyield",
    reasonCode: "missing-runtime-route-evidence",
    exactFactPath: "gap:exit:local-component:stusd-stoneyield:gap:exit-routes",
  },
  "susd-hedgecore": {
    assetId: "susd-hedgecore",
    reasonCode: "missing-runtime-route-evidence",
    exactFactPath: "gap:exit:local-component:susd-hedgecore:gap:exit-routes",
  },
  "usda-alpha-partner": {
    assetId: "usda-alpha-partner",
    reasonCode: "missing-runtime-route-evidence",
    exactFactPath: "gap:exit:local-component:usda-alpha-partner:gap:exit-routes",
  },
  "uusd-anything-labs": {
    assetId: "uusd-anything-labs",
    reasonCode: "missing-runtime-route-evidence",
    exactFactPath: "gap:exit:local-component:uusd-anything-labs:gap:exit-routes",
  },
} as const;

describe("constant-product V2 execution", () => {
  it("admits only the reviewed V2 families", () => {
    expect(makeCandidate()).toMatchObject({ source: "pancakeswap-v2", poolAddress: PAIR });
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "bsc",
        protocol: "pancakeswap-v2-bsc",
        poolType: "cg-cl-30bp",
        poolAddress: PAIR,
        tokenAddresses: [U, WBNB],
      }),
    ).toBeNull();
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "bsc",
        protocol: "pancakeswap-v2-bsc",
        poolType: "ds-amm",
        poolAddress: PAIR,
        tokenAddresses: [U, WBNB],
      }),
    ).toMatchObject({ source: "pancakeswap-v2" });
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "bsc",
        protocol: "pancakeswap-v3",
        poolType: "gt-concentrated",
        poolAddress: PAIR,
        tokenAddresses: [U, WBNB],
      }),
    ).toBeNull();
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "ethereum",
        protocol: "uniswap-v2",
        poolType: "generic",
        poolAddress: "0x14d7aab5b4bca6a02e52ac22520b033bf35f4091",
        tokenAddresses: ["0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
      }),
    ).toMatchObject({ source: "uniswap-v2" });
    expect(makeAerodromeCandidate()).toMatchObject({
      source: "aerodrome-volatile",
      poolAddress: AERODROME_PAIR,
    });
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "base",
        protocol: "aerodrome",
        poolType: "aerodrome-volatile",
        poolAddress: AERODROME_PAIR,
        tokenAddresses: [USDC_BASE, WETH_BASE],
      }),
    ).toBeNull();
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "base",
        protocol: "aerodrome",
        poolType: "aerodrome-stable",
        poolAddress: AERODROME_PAIR,
        tokenAddresses: [USDC_BASE, WETH_BASE],
        confirmedStable: true,
      }),
    ).toBeNull();
    expect(
      buildEvmV2ExecutionCandidate({
        chain: "avalanche",
        protocol: "aerodrome",
        poolType: "aerodrome-volatile",
        poolAddress: AERODROME_PAIR,
        tokenAddresses: [USDC_BASE, WETH_BASE],
        confirmedStable: false,
      }),
    ).toBeNull();
  });

  it("transfers an exact staged candidate onto a retained DL fingerprint", () => {
    const candidate = makeCandidate();
    const metric = initMetrics("u-united-stables", "U");
    metric.topPools.push({
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
    expect(metric.topPools[0]!.extra?.evmV2ExecutionCandidate).toEqual(candidate);
  });

  it("resolves exact candidates before a unique fingerprint and fails ambiguous fingerprints closed", () => {
    const candidate = makeAerodromeCandidate();
    const exactCandidates = new Map([
      [canonicalExitRouteAssetKey("base", candidate.poolAddress), candidate],
    ]);
    const uniqueCandidates = buildUniqueEvmV2ExecutionCandidateFingerprintIndex(exactCandidates);
    const resolve = (poolAddressOrId: string) =>
      resolveEvmV2ExecutionCandidate({
        chain: "base",
        protocol: "aerodrome",
        poolAddressOrId,
        tokenAddresses: [USDC_BASE, WETH_BASE],
        exactCandidates,
        uniqueFingerprintCandidates: uniqueCandidates,
      });

    expect(resolve("defillama-pool-uuid")).toEqual(candidate);

    const sibling = {
      ...candidate,
      poolAddress: "0x1111111111111111111111111111111111111111" as const,
    };
    const ambiguousExactCandidates = new Map([
      [canonicalExitRouteAssetKey("base", candidate.poolAddress), candidate],
      [canonicalExitRouteAssetKey("base", sibling.poolAddress), sibling],
    ]);
    const ambiguousCandidates =
      buildUniqueEvmV2ExecutionCandidateFingerprintIndex(ambiguousExactCandidates);

    expect(
      resolveEvmV2ExecutionCandidate({
        chain: "base",
        protocol: "aerodrome",
        poolAddressOrId: "defillama-pool-uuid",
        tokenAddresses: [USDC_BASE, WETH_BASE],
        exactCandidates: ambiguousExactCandidates,
        uniqueFingerprintCandidates: ambiguousCandidates,
      }),
    ).toBeUndefined();
    expect(
      resolveEvmV2ExecutionCandidate({
        chain: "base",
        protocol: "aerodrome",
        poolAddressOrId: candidate.poolAddress,
        tokenAddresses: [USDC_BASE, WETH_BASE],
        exactCandidates: ambiguousExactCandidates,
        uniqueFingerprintCandidates: ambiguousCandidates,
      }),
    ).toEqual(candidate);
  });

  it("builds a same-block Pancake V2 model after factory and pair verification", async () => {
    const candidate = makeCandidate();
    const metric = initMetrics("u-united-stables", "U");
    metric.topPools.push({
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
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("bsc", U), metric.stablecoinId]]),
      contractMetaByChainAddress: new Map([
        [
          canonicalExitRouteAssetKey("bsc", U),
          { stablecoinId: metric.stablecoinId, symbol: "U", decimals: 18, source: "contract" },
        ],
      ]),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      chainRpcs: new Map([
        [
          "bsc",
          {
            chainId: "bsc",
            chainName: "BSC",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 50_000_000),
        fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
    });

    const retained = metric.topPools[0]!;
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

  it("implies the tracked V2 input from a unique authoritative counter-asset", async () => {
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "uniswap-v2")!;
    const chainAddressToId = new Map([
      [canonicalExitRouteAssetKey("ethereum", A7A5), "a7a5-old-vector"],
      [canonicalExitRouteAssetKey("ethereum", USDT_ETHEREUM), "usdt-tether"],
    ]);
    const chainRpcs = new Map([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example",
          explorerUrl: "https://example.com",
        },
      ],
    ]);
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
      const metric = initMetrics("a7a5-old-vector", "A7A5");
      metric.topPools.push({
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
        metrics: new Map([[metric.stablecoinId, metric]]),
        chainAddressToId,
        contractMetaByChainAddress: new Map(),
        stablecoinPriceById,
        chainRpcs: chainRpcs as never,
        dependencies: {
          fetchBlockNumber: vi.fn(async () => 21_000_000),
          fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
          fetchMulticall: fetchMulticall as never,
          hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
        },
      });
      return metric.topPools[0]!;
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
    const metric = initMetrics("spusd-soulpeg", "SPUSD");
    metric.topPools.push({
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
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map([
        [canonicalExitRouteAssetKey("bsc", SPUSD), "spusd-soulpeg"],
        [canonicalExitRouteAssetKey("bsc", USDC_BSC), "usdc-circle"],
      ]),
      contractMetaByChainAddress: new Map(),
      stablecoinPriceById: new Map([["usdc-circle", 1]]),
      chainRpcs: new Map([
        [
          "bsc",
          {
            chainId: "bsc",
            chainName: "BSC",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 50_000_000),
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
                    : call.label.endsWith("-decimals0")
                      ? word(18n)
                      : word(18n),
          })),
        ) as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
    });

    expect(metric.topPools[0]!.extra?.executionCapabilityGate).toBeUndefined();
    expect(metric.topPools[0]!.extra?.ammExecutionModel).toMatchObject({
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

    expect(metric.topPools[0]!.extra?.executionCapabilityGate).toBeUndefined();
    expect(metric.topPools[0]!.extra?.ammExecutionModel).toMatchObject({
      source: "uniswap-v2",
      trackedTokenIndex: 0,
      tokens: [
        { address: KAG, referencePriceSource: "pool-implied", referencePriceUsd: (1 * 4_300) / 14 },
        { address: XAUT, referencePriceSource: "tracked-market", referencePriceUsd: 4_300 },
      ],
    });
  });

  it("still gates a captured V2 pair when no token has a trusted quote leg", async () => {
    const metric = await runV2PriceLegScenario({
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("ethereum", KAG), "kag-kinesis"]]),
      stablecoinPriceById: new Map(),
    });

    expect(metric.topPools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.topPools[0]!.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "incomplete-exact-capture",
    });
  });

  it("bounds deployment probes so one oversized request cannot gate every V2 pool", async () => {
    const metric = initMetrics("u-united-stables", "U");
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
      metric.topPools.push({
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
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("bsc", U), metric.stablecoinId]]),
      contractMetaByChainAddress: new Map(),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      chainRpcs: new Map([
        [
          "bsc",
          {
            chainId: "bsc",
            chainName: "BSC",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 50_000_000),
        fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
      },
    });

    expect(fetchMulticall).toHaveBeenCalledTimes(2);
    expect(fetchMulticall.mock.calls.map((call) => call[1].length)).toEqual([24, 6]);
    expect(metric.topPools.every((pool) => pool.extra?.ammExecutionModel?.source === "pancakeswap-v2")).toBe(true);
  });

  it("builds a classic Base Aerodrome volatile model with same-block deployment and fee checks", async () => {
    const candidate = makeAerodromeCandidate();
    const metric = initMetrics("usdc-circle", "USDC");
    metric.topPools.push({
      poolId: buildPoolFingerprint("base", "aerodrome", [USDC_BASE, WETH_BASE])!,
      project: "aerodrome",
      chain: "Base",
      tvlUsd: 2_000_000,
      symbol: "USDC-WETH",
      volumeUsd1d: 100_000,
      poolType: "aerodrome-volatile",
      source: "dl",
      extra: { evmV2ExecutionCandidate: candidate },
    });
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "aerodrome-volatile");
    if (!deployment || deployment.binding !== "aerodrome-volatile") throw new Error("missing Aerodrome deployment");

    const fetchCodeAtBlock = vi.fn(async (_chain: string, address: string) =>
      address === deployment.factoryAddress ? ("0x6000" as const) : ("0x6001" as const),
    );
    const fetchMulticall = vi.fn(
      async (_chain: string, calls: readonly { label: string; callData: string }[], _blockNumber: number) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData:
            call.label === "v2-factory-implementation"
              ? addressWord(deployment.expectedImplementationAddress)
              : call.label === "v2-factory-paused"
                ? word(0n)
                : call.label.endsWith("-pair")
                  ? addressWord(AERODROME_PAIR)
                  : call.label.endsWith("-token0")
                    ? addressWord(USDC_BASE)
                    : call.label.endsWith("-token1")
                      ? addressWord(WETH_BASE)
                      : call.label.endsWith("-reserves")
                        ? reservesWord(1_000_000n * 10n ** 6n, 500n * 10n ** 18n)
                        : call.label.endsWith("-fee")
                          ? word(42n)
                          : call.label.endsWith("-stable")
                            ? word(0n)
                            : call.label.endsWith("-decimals0")
                              ? word(6n)
                              : word(18n),
        })),
    );

    await enrichEvmV2ExecutionModels({
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map([[canonicalExitRouteAssetKey("base", USDC_BASE), metric.stablecoinId]]),
      contractMetaByChainAddress: new Map([
        [
          canonicalExitRouteAssetKey("base", USDC_BASE),
          { stablecoinId: metric.stablecoinId, symbol: "USDC", decimals: 6, source: "contract" },
        ],
      ]),
      stablecoinPriceById: new Map([[metric.stablecoinId, 1]]),
      chainRpcs: new Map([
        [
          "base",
          {
            chainId: "base",
            chainName: "Base",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 33_000_000),
        fetchCodeAtBlock: fetchCodeAtBlock as never,
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn((code) =>
          code === "0x6000" ? deployment.expectedFactoryCodeHash : deployment.expectedImplementationCodeHash,
        ),
      },
    });

    const calls = fetchMulticall.mock.calls.flatMap((call) => call[1]);
    expect(calls.find((call) => call.label === "v2-0-pair")?.callData).toMatch(/^0x79bc57d5/);
    expect(calls.find((call) => call.label === "v2-0-pair")?.callData).toMatch(/0{64}$/);
    expect(calls.find((call) => call.label === "v2-0-fee")?.callData).toMatch(/^0xcc56b2c5/);
    expect(fetchCodeAtBlock).toHaveBeenNthCalledWith(
      1,
      "base",
      deployment.factoryAddress,
      33_000_000,
      expect.any(Object),
    );
    expect(fetchCodeAtBlock).toHaveBeenNthCalledWith(
      2,
      "base",
      deployment.expectedImplementationAddress,
      33_000_000,
      expect.any(Object),
    );
    expect(metric.topPools[0]!.extra?.ammExecutionModel).toMatchObject({
      source: "aerodrome-volatile",
      invariant: "constant-product",
      feeRate: 0.0042,
      trackedTokenIndex: 0,
      tokens: [
        { address: USDC_BASE, balance: 1_000_000, referencePriceUsd: 1 },
        { address: WETH_BASE, balance: 500, referencePriceUsd: 2_000 },
      ],
    });
  });

  it("fails classic Aerodrome volatile execution closed while the factory is paused", async () => {
    const candidate = makeAerodromeCandidate();
    const metric = initMetrics("usdc-circle", "USDC");
    metric.topPools.push({
      poolId: `base:${AERODROME_PAIR}`,
      project: "aerodrome",
      chain: "Base",
      tvlUsd: 2_000_000,
      symbol: "USDC-WETH",
      volumeUsd1d: 100_000,
      poolType: "aerodrome-volatile",
      source: "dl",
      extra: { evmV2ExecutionCandidate: candidate },
    });
    const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "aerodrome-volatile");
    if (!deployment || deployment.binding !== "aerodrome-volatile") throw new Error("missing Aerodrome deployment");

    await enrichEvmV2ExecutionModels({
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map(),
      contractMetaByChainAddress: new Map(),
      stablecoinPriceById: new Map(),
      chainRpcs: new Map([
        [
          "base",
          {
            chainId: "base",
            chainName: "Base",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 33_000_000),
        fetchCodeAtBlock: vi.fn(async (_chain, address) =>
          address === deployment.factoryAddress ? ("0x6000" as const) : ("0x6001" as const),
        ),
        fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
          calls.map((call) => ({
            label: call.label,
            success: true,
            returnData:
              call.label === "v2-factory-implementation"
                ? addressWord(deployment.expectedImplementationAddress)
                : call.label === "v2-factory-paused"
                  ? word(1n)
                  : word(0n),
          })),
        ) as never,
        hashCode: vi.fn((code) =>
          code === "0x6000" ? deployment.expectedFactoryCodeHash : deployment.expectedImplementationCodeHash,
        ),
      },
    });

    expect(metric.topPools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.topPools[0]!.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "paused-or-swap-disabled",
    });
  });

  it("fails closed when the canonical factory runtime does not match", async () => {
    const metric = initMetrics("u-united-stables", "U");
    metric.topPools.push({
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
      metrics: new Map([[metric.stablecoinId, metric]]),
      chainAddressToId: new Map(),
      contractMetaByChainAddress: new Map(),
      stablecoinPriceById: new Map(),
      chainRpcs: new Map([
        [
          "bsc",
          {
            chainId: "bsc",
            chainName: "BSC",
            type: "evm",
            rpcUrl: "https://rpc.example",
            explorerUrl: "https://example.com",
          },
        ],
      ]),
      dependencies: {
        fetchBlockNumber: vi.fn(async () => 50_000_000),
        fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
        fetchMulticall: fetchMulticall as never,
        hashCode: vi.fn(() => `0x${"00".repeat(32)}` as `0x${string}`),
      },
    });

    expect(metric.topPools[0]!.extra?.ammExecutionModel).toBeUndefined();
    expect(metric.topPools[0]!.extra?.evmV2ExecutionCandidate).toBeUndefined();
    expect(metric.topPools[0]!.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "deployment-code-mismatch",
    });
    expect(fetchMulticall).not.toHaveBeenCalled();
  });

  for (const replay of EVM_V2_REPLAY_CASES) {
    it(`replays the exact U5 tuple and complete V2 curve for ${replay.assetId}`, async () => {
      const result = await runReplay(replay);
      const retained = result.metric.topPools[0]!;
      const model = retained.extra?.ammExecutionModel;
      const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
        (entry) => entry.source === "pancakeswap-v2",
      )!;

      expect(replay.fact).toEqual(EXPECTED_U5_FACTS[replay.assetId as keyof typeof EXPECTED_U5_FACTS]);
      expect(retained.poolId).toBe(`bsc:${replay.poolAddress}`);
      expect(retained.extra?.executionCapabilityGate).toBeUndefined();
      expect(model).toBeDefined();
      expect(validateAmmExecutionModel(model!, {
        chain: "bsc",
        stablecoinId: replay.assetId,
        retainedTvlUsd: EVM_V2_RETAINED_TVL_USD,
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
      expect(DexExecutionProfileV2Schema.parse(reviewed.profileV2)).toEqual(reviewed.profileV2);

      const registration = getDexExecutionCapabilityRegistration("evm-v2-constant-product-v1");
      expect(registration).not.toBeNull();
      expect(isDexExecutionProfileAdmittedForScoring(reviewed.profileV2, registration!)).toBe(true);
    });
  }

  it("rejects a factory result bound to a different pair address", async () => {
    const replay = EVM_V2_REPLAY_CASES[1]!;
    const result = await runReplay(replay, {
      mutateResults: (results) => {
        results.find((entry) => entry.label.endsWith("-pair"))!.returnData =
          fixtureAddressWord("0x0000000000000000000000000000000000005bad");
      },
    });

    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "exact-pool-join-unresolved",
    });
  });

  it("rejects a pair whose token identity is not the staged counter-asset pair", async () => {
    const replay = EVM_V2_REPLAY_CASES[2]!;
    const result = await runReplay(replay, {
      mutateResults: (results) => {
        results.find((entry) => entry.label.endsWith("-token0"))!.returnData =
          fixtureAddressWord("0x0000000000000000000000000000000000005bad");
      },
    });

    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "ambiguous-token-identity",
    });
  });

  it("rejects a malformed reserve snapshot instead of producing partial depth", async () => {
    const replay = EVM_V2_REPLAY_CASES[3]!;
    const result = await runReplay(replay, {
      mutateResults: (results) => {
        results.find((entry) => entry.label.endsWith("-reserves"))!.returnData =
          `${reservesWord(
            2_000_000_000n * 10n ** 18n,
            2_000_000_000n * 10n ** 18n,
          )}00`;
      },
    });

    expect(result.pool.extra?.ammExecutionModel).toBeUndefined();
    expect(result.pool.extra?.executionCapabilityGate).toEqual({
      family: "constant-product-v2",
      reason: "incomplete-exact-capture",
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
      reason: "incomplete-exact-capture",
    });
  });
});
