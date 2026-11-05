import { vi } from "vitest";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import { initSourcePoolGraph } from "../pool-helpers";
import { buildEvmV2RegisteredExecutionTarget } from "../execution-targets/evm-v2";
import { EVM_V2_EXECUTION_DEPLOYMENTS, buildEvmV2ExecutionCandidate, enrichEvmV2ExecutionModels } from "../constant-product-v2";
import { EVM_V2_REPLAY_BLOCK, EVM_V2_RETAINED_TVL_USD, replayCandidate, replayMulticallResults, replayPool } from "./fixtures/evm-v2-fixtures";
import type { EvmMulticall3Result } from "../../../lib/evm-rpc";
import { canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import { makeChainRpcConfig } from "../../../test-helpers/chain-rpc-fixtures.test-support";
import type { EvmV2ReplayCase } from "./fixtures/evm-v2-fixtures";

export function captureRpcs(chainId: string, chainName: string) {
  return new Map([[chainId, makeChainRpcConfig({
    chainId, chainName, rpcUrls: ["https://rpc.example"], explorerUrl: "https://example.com",
  })]]);
}

export function replayTokenLookups(replay: EvmV2ReplayCase) {
  const tokens = [
    { address: replay.stablecoinAddress, stablecoinId: replay.assetId, symbol: replay.stablecoinSymbol, decimals: replay.stablecoinDecimals },
    { address: replay.counterAddress, stablecoinId: replay.counterAssetId, symbol: replay.counterSymbol, decimals: replay.counterDecimals },
  ];
  return {
    chainAddressToId: new Map(tokens.map((token) => [canonicalExitRouteAssetKey("bsc", token.address), token.stablecoinId])),
    contractMetaByChainAddress: new Map(tokens.map(({ address, ...token }) => [
      canonicalExitRouteAssetKey("bsc", address), { ...token, source: "contract" as const },
    ])),
  };
}

const U = "0xce24439f2d9c6a2289f741120fe202248b666666" as const;
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" as const;
const PAIR = "0x108752b2a22c731ede3edac2205c63ae553e221a" as const;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;
const AERODROME_PAIR = "0xcdac0d6c6c59727a65f871236188350531885c43" as const;
const KAG = "0x56ba8b58b7d1f6d384a1c4dd553f39ebc8741b8e" as const;
const XAUT = "0x68749665ff8d2d112fa859aa293f07a622782f38" as const;
const KAG_XAUT_PAIR = "0x2222222222222222222222222222222222222222" as const;

export function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function reservesWord(reserve0: bigint, reserve1: bigint): `0x${string}` {
  return `0x${reserve0.toString(16).padStart(64, "0")}${reserve1.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
}

export function blockHeader(blockNumber: number) {
  return {
    number: blockNumber,
    timestamp: 1_700_000_000,
    hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  };
}

export function makeCandidate() {
  return buildEvmV2ExecutionCandidate({
    chain: "bsc",
    protocol: "pancakeswap",
    poolType: "ds-amm",
    poolAddress: PAIR,
    tokenAddresses: [U, WBNB],
    tokenSymbols: ["U", "WBNB"],
  })!;
}

export function makeAerodromeCandidate() {
  return buildEvmV2ExecutionCandidate({
    chain: "base",
    protocol: "aerodrome",
    poolType: "aerodrome-volatile",
    poolAddress: AERODROME_PAIR,
    tokenAddresses: [USDC_BASE, WETH_BASE],
    tokenSymbols: ["USDC", "WETH"],
  })!;
}

export async function runV2PriceLegScenario({
  chainAddressToId,
  stablecoinPriceById,
  candidateTokenAddresses = [KAG, XAUT],
  candidateTokenSymbols = ["KAG", "XAUt"],
  actualToken0 = KAG,
  actualToken1 = XAUT,
  candidateDecimals0 = 18n,
  candidateDecimals1 = 6n,
  actualReserve0 = 14n * 10n ** 18n,
  actualReserve1 = 1n * 10n ** 6n,
}: {
  chainAddressToId: Map<string, string>;
  stablecoinPriceById: Map<string, number>;
  candidateTokenAddresses?: readonly string[];
  candidateTokenSymbols?: readonly string[];
  actualToken0?: string;
  actualToken1?: string;
  candidateDecimals0?: bigint;
  candidateDecimals1?: bigint;
  actualReserve0?: bigint;
  actualReserve1?: bigint;
}) {
  const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find((entry) => entry.source === "uniswap-v2")!;
  const candidate = buildEvmV2ExecutionCandidate({
    chain: "ethereum",
    protocol: "uniswap-v2",
    poolType: "generic",
    poolAddress: KAG_XAUT_PAIR,
    tokenAddresses: candidateTokenAddresses,
    tokenSymbols: candidateTokenSymbols,
  })!;
  const metric = initSourcePoolGraph("kag-kinesis", "KAG");
  metric.pools.push({
    poolId: canonicalExitRouteAssetKey("ethereum", KAG_XAUT_PAIR),
    project: "uniswap-v2",
    chain: "Ethereum",
    tvlUsd: 1_519,
    symbol: candidateTokenSymbols.join(" / "),
    volumeUsd1d: 200,
    poolType: "cg-amm",
    source: "cg_onchain",
    extra: { evmV2ExecutionCandidate: candidate },
  });
  await enrichEvmV2ExecutionModels({
    nowSec: 1_700_000_000,
    sourceGenerationId: "dex-stage:fixture",
    metrics: new Map([[metric.stablecoinId, metric]]),
    chainAddressToId,
    contractMetaByChainAddress: new Map(),
    stablecoinPriceById,
    chainRpcs: captureRpcs("ethereum", "Ethereum"),
    dependencies: {
      fetchBlockNumber: vi.fn(async () => 21_000_000),
      fetchBlockHeader: vi.fn(async (_chain: string, blockNumber: number | "finalized") =>
        blockHeader(blockNumber as number)),
      fetchCodeAtBlock: vi.fn(async () => "0x6000" as const),
      fetchMulticall: vi.fn(async (_chain: string, calls: readonly { label: string }[]) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: call.label.endsWith("-pair")
            ? addressWord(KAG_XAUT_PAIR)
            : call.label.endsWith("-token0")
              ? addressWord(actualToken0)
              : call.label.endsWith("-token1")
                ? addressWord(actualToken1)
                : call.label.endsWith("-reserves")
                  ? reservesWord(actualReserve0, actualReserve1)
                  : call.label.endsWith("-decimals0")
                    ? word(candidateDecimals0)
                    : call.label.endsWith("-decimals1")
                      ? word(candidateDecimals1)
                      : word(6n),
        })),
      ) as never,
      hashCode: vi.fn(() => deployment.expectedFactoryCodeHash),
    },
  });
  return metric;
}

export function targetForReplay(replay: EvmV2ReplayCase): DexMeasuredExecutionTarget {
  const { chainAddressToId, contractMetaByChainAddress } = replayTokenLookups(replay);
  const output = buildEvmV2RegisteredExecutionTarget({
    context: {
      chainAddressToId,
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

export async function runReplay(
  replay: EvmV2ReplayCase,
  options: {
    blockNumber?: number;
    serveOnlyBlock?: number;
    mutateResults?: (results: EvmMulticall3Result[]) => void;
    reorgOnConfirmation?: boolean;
    headerTimestamp?: number;
  } = {},
) {
  const candidate = replayCandidate(replay);
  const metric = initSourcePoolGraph(replay.assetId, replay.stablecoinSymbol);
  const pool = replayPool(replay, candidate);
  metric.pools.push(pool);
  const { chainAddressToId, contractMetaByChainAddress } = replayTokenLookups(replay);
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
      const results: EvmMulticall3Result[] = replayMulticallResults(replay, calls);
      options.mutateResults?.(results);
      return results;
    },
  );
  const deployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
    (entry) => entry.source === "pancakeswap-v2",
  )!;

  let headerReads = 0;
  await enrichEvmV2ExecutionModels({
    nowSec: 1_700_000_000,
    sourceGenerationId: "dex-stage:fixture",
    metrics: new Map([[metric.stablecoinId, metric]]),
    chainAddressToId,
    contractMetaByChainAddress,
    stablecoinPriceById: new Map([
      [replay.assetId, 1],
      [replay.counterAssetId, 1],
    ]),
    stablecoinPriceProvenanceById: new Map([
      [replay.assetId, { referencePriceSourceId: "stablecoins-cache:fixture", referencePriceObservedAt: 1_699_999_880 }],
      [replay.counterAssetId, { referencePriceSourceId: "stablecoins-cache:fixture", referencePriceObservedAt: 1_699_999_880 }],
    ]),
    chainRpcs: captureRpcs("bsc", "BSC"),
    dependencies: {
      fetchBlockNumber,
      fetchBlockHeader: vi.fn(async (_chain: string, blockNumber: number | "finalized") => {
        const header = blockHeader(blockNumber as number);
        if (options.headerTimestamp != null) header.timestamp = options.headerTimestamp;
        if (options.reorgOnConfirmation && headerReads++ > 0) {
          header.hash = `0x${"cd".repeat(32)}`;
        }
        return header;
      }),
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
