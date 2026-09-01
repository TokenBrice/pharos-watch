import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_MAX_COST_BPS,
  DEX_MEASURED_TARGET_SCHEMA_VERSION,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionQuotePointProof,
  projectDexMeasuredExecutionProfileToV2,
  type DexExecutionProfileV2,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { buildAmmCapacityCurve } from "@shared/lib/p4-exit-route-amm-simulation";
import type { DexAmmExecutionModel } from "@shared/types/market";
import { EVM_V2_EXECUTION_DEPLOYMENTS } from "../../constant-product-v2";
import { buildPoolFingerprint } from "../../pool-helpers";
import { buildDexMeasuredExecutionProfile } from "../../../measured-execution/profiles";
import type { EvmV2ExecutionCandidate, PoolEntry } from "../../types";

export const EVM_V2_REPLAY_BLOCK = 50_657_000;
export const EVM_V2_RETAINED_TVL_USD = 4_000_000_000;
export const EVM_V2_RESERVE_UNITS = 2_000_000_000n;

const USDC_BSC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" as const;
const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955" as const;

export interface EvmV2ReplayCase {
  readonly assetId: string;
  readonly stablecoinSymbol: string;
  readonly stablecoinAddress: `0x${string}`;
  readonly stablecoinDecimals: number;
  readonly counterAssetId: string;
  readonly counterSymbol: string;
  readonly counterAddress: `0x${string}`;
  readonly counterDecimals: number;
  readonly poolAddress: `0x${string}`;
  readonly pairTokenOrder: "stable-first" | "counter-first";
  readonly fact: {
    readonly assetId: string;
    readonly reasonCode: string;
    readonly exactFactPath: string;
  };
}

export const EVM_V2_REPLAY_CASES: readonly EvmV2ReplayCase[] = [
  {
    assetId: "idrt-rupiah-token",
    stablecoinSymbol: "IDRT",
    stablecoinAddress: "0x66207e39bb77e6b99aab56795c7c340c08520d83",
    stablecoinDecimals: 2,
    counterAssetId: "usdt-tether",
    counterSymbol: "USDT",
    counterAddress: USDT_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005001",
    pairTokenOrder: "stable-first",
    fact: {
      assetId: "idrt-rupiah-token",
      reasonCode: "unsupported-same-notional-route",
      exactFactPath: "exit:unsupported-same-notional-route",
    },
  },
  {
    assetId: "spusd-soulpeg",
    stablecoinSymbol: "SPUSD",
    stablecoinAddress: "0x40ff3dea2eec93a7b71879874dc4407918da77a6",
    stablecoinDecimals: 18,
    counterAssetId: "usdc-circle",
    counterSymbol: "USDC",
    counterAddress: USDC_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005002",
    pairTokenOrder: "stable-first",
    fact: {
      assetId: "spusd-soulpeg",
      reasonCode: "missing-runtime-route-evidence",
      exactFactPath: "gap:exit:local-component:spusd-soulpeg:gap:exit-routes",
    },
  },
  {
    assetId: "stusd-stoneyield",
    stablecoinSymbol: "STUSD",
    stablecoinAddress: "0x806dd21af6de051fb811760a5768d04a99160eb9",
    stablecoinDecimals: 18,
    counterAssetId: "usdc-circle",
    counterSymbol: "USDC",
    counterAddress: USDC_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005003",
    pairTokenOrder: "counter-first",
    fact: {
      assetId: "stusd-stoneyield",
      reasonCode: "missing-runtime-route-evidence",
      exactFactPath: "gap:exit:local-component:stusd-stoneyield:gap:exit-routes",
    },
  },
  {
    assetId: "susd-hedgecore",
    stablecoinSymbol: "sUSD",
    stablecoinAddress: "0xbe1922750760c4cae69edb6fe79a22ae9b62a23d",
    stablecoinDecimals: 18,
    counterAssetId: "usdc-circle",
    counterSymbol: "USDC",
    counterAddress: USDC_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005004",
    pairTokenOrder: "stable-first",
    fact: {
      assetId: "susd-hedgecore",
      reasonCode: "missing-runtime-route-evidence",
      exactFactPath: "gap:exit:local-component:susd-hedgecore:gap:exit-routes",
    },
  },
  {
    assetId: "usda-alpha-partner",
    stablecoinSymbol: "USDA",
    stablecoinAddress: "0x17eafd08994305d8ace37efb82f1523177ec70ee",
    stablecoinDecimals: 18,
    counterAssetId: "usdt-tether",
    counterSymbol: "USDT",
    counterAddress: USDT_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005005",
    pairTokenOrder: "counter-first",
    fact: {
      assetId: "usda-alpha-partner",
      reasonCode: "missing-runtime-route-evidence",
      exactFactPath: "gap:exit:local-component:usda-alpha-partner:gap:exit-routes",
    },
  },
  {
    assetId: "uusd-anything-labs",
    stablecoinSymbol: "UUSD",
    stablecoinAddress: "0x61a10e8556bed032ea176330e7f17d6a12a10000",
    stablecoinDecimals: 18,
    counterAssetId: "usdc-circle",
    counterSymbol: "USDC",
    counterAddress: USDC_BSC,
    counterDecimals: 18,
    poolAddress: "0x0000000000000000000000000000000000005006",
    pairTokenOrder: "stable-first",
    fact: {
      assetId: "uusd-anything-labs",
      reasonCode: "missing-runtime-route-evidence",
      exactFactPath: "gap:exit:local-component:uusd-anything-labs:gap:exit-routes",
    },
  },
] as const;

export function rawUnits(units: bigint, decimals: number): bigint {
  return units * 10n ** BigInt(decimals);
}

export function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function addressWord(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function reservesWord(reserve0: bigint, reserve1: bigint): `0x${string}` {
  return `0x${reserve0.toString(16).padStart(64, "0")}${reserve1
    .toString(16)
    .padStart(64, "0")}${"0".repeat(64)}`;
}

export function replayCandidate(replay: EvmV2ReplayCase): EvmV2ExecutionCandidate {
  return {
    source: "pancakeswap-v2",
    poolAddress: replay.poolAddress,
    tokenAddresses: [replay.stablecoinAddress, replay.counterAddress],
    tokenSymbols: [replay.stablecoinSymbol, replay.counterSymbol],
  };
}

export function replayPool(
  replay: EvmV2ReplayCase,
  candidate: EvmV2ExecutionCandidate,
): PoolEntry {
  return {
    poolId: buildPoolFingerprint("bsc", "pancakeswap", [...candidate.tokenAddresses])!,
    project: "pancakeswap",
    chain: "BSC",
    tvlUsd: EVM_V2_RETAINED_TVL_USD,
    symbol: `${replay.stablecoinSymbol} / ${replay.counterSymbol}`,
    volumeUsd1d: 100_000,
    volumeUsd7d: 700_000,
    poolType: "cg-amm",
    source: "cg_onchain",
    extra: { evmV2ExecutionCandidate: candidate },
  };
}

export function replayTarget(replay: EvmV2ReplayCase): DexMeasuredExecutionTarget {
  const poolId = `bsc:${replay.poolAddress}`;
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: "evm-v2-constant-product-v1",
      stablecoinId: replay.assetId,
      chain: "bsc",
      protocol: "pancakeswap",
      poolId,
      tokenInAddress: replay.stablecoinAddress,
      tokenOutAddress: replay.counterAddress,
      poolTokenAddresses: [replay.stablecoinAddress, replay.counterAddress],
      feePips: 2_500,
    }),
    stablecoinId: replay.assetId,
    adapterProfileId: "evm-v2-constant-product-v1",
    protocol: "pancakeswap",
    chain: "bsc",
    poolId,
    poolTokenAddresses: [replay.stablecoinAddress, replay.counterAddress],
    tokenIn: {
      address: replay.stablecoinAddress,
      symbol: replay.stablecoinSymbol,
      decimals: replay.stablecoinDecimals,
      referencePriceUsd: 1,
      trackedAssetId: replay.assetId,
    },
    tokenOut: {
      address: replay.counterAddress,
      symbol: replay.counterSymbol,
      decimals: replay.counterDecimals,
      referencePriceUsd: 1,
      trackedAssetId: replay.counterAssetId,
    },
    feePips: 2_500,
    retainedTvlUsd: EVM_V2_RETAINED_TVL_USD,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_700_000_000,
  };
}

export function replayMulticallResults(
  replay: EvmV2ReplayCase,
  calls: readonly { label: string; target?: string }[],
): { label: string; success: true; returnData: `0x${string}` }[] {
  const actualToken0 =
    replay.pairTokenOrder === "stable-first" ? replay.stablecoinAddress : replay.counterAddress;
  const actualToken1 =
    replay.pairTokenOrder === "stable-first" ? replay.counterAddress : replay.stablecoinAddress;
  const actualDecimals0 =
    replay.pairTokenOrder === "stable-first" ? replay.stablecoinDecimals : replay.counterDecimals;
  const actualDecimals1 =
    replay.pairTokenOrder === "stable-first" ? replay.counterDecimals : replay.stablecoinDecimals;

  return calls.map((call) => ({
    label: call.label,
    success: true as const,
    returnData: call.label.endsWith("-pair")
      ? addressWord(replay.poolAddress)
      : call.label.endsWith("-token0")
        ? addressWord(actualToken0)
        : call.label.endsWith("-token1")
          ? addressWord(actualToken1)
          : call.label.endsWith("-reserves")
            ? reservesWord(
                rawUnits(EVM_V2_RESERVE_UNITS, actualDecimals0),
                rawUnits(EVM_V2_RESERVE_UNITS, actualDecimals1),
              )
            : call.target?.toLowerCase() === replay.stablecoinAddress
              ? word(BigInt(replay.stablecoinDecimals))
              : call.target?.toLowerCase() === replay.counterAddress
                ? word(BigInt(replay.counterDecimals))
                : word(18n),
  }));
}

function rawAmountForUsd(amountUsd: number, decimals: number, priceUsd: number): bigint {
  return BigInt(Math.floor((amountUsd / priceUsd) * 10 ** decimals));
}

function rawOutputForModel(
  model: DexAmmExecutionModel,
  outputTokenIndex: number,
  amountInRaw: bigint,
): bigint {
  const input = model.tokens[model.trackedTokenIndex]!;
  const output = model.tokens[outputTokenIndex]!;
  const inputAmount = Number(amountInRaw) / 10 ** input.decimals;
  const effectiveInput = inputAmount * (1 - model.feeRate);
  const outputAmount = (output.balance * effectiveInput) / (input.balance + effectiveInput);
  return BigInt(Math.floor(outputAmount * 10 ** output.decimals));
}

export function buildReviewedV2Profile(input: {
  replay: EvmV2ReplayCase;
  model: DexAmmExecutionModel;
  target: DexMeasuredExecutionTarget;
}): {
  profile: DexMeasuredExecutionProfile;
  profileV2: DexExecutionProfileV2;
  capacityCurve: ReturnType<typeof buildAmmCapacityCurve>;
} {
  const { replay, model, target } = input;
  const outputTokenIndex = model.trackedTokenIndex === 0 ? 1 : 0;
  const inputToken = model.tokens[model.trackedTokenIndex]!;
  const outputToken = model.tokens[outputTokenIndex]!;
  const requestedNotionals = [1_000, ...DEX_MEASURED_CAPACITY_NOTIONALS_USD];
  const capacityCurve = buildAmmCapacityCurve(model, outputTokenIndex);
  const points = requestedNotionals.map((inputUsd, index) => {
    const amountInRaw = rawAmountForUsd(inputUsd, inputToken.decimals, inputToken.referencePriceUsd);
    const amountOutRaw = rawOutputForModel(model, outputTokenIndex, amountInRaw);
    const outputUsd =
      (Number(amountOutRaw) / 10 ** outputToken.decimals) * outputToken.referencePriceUsd;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return {
      amountInRaw: amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: `0x${(index + 1).toString(16).padStart(2, "0")}`,
      returnData: word(amountOutRaw),
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
    };
  });
  const pancakeDeployment = EVM_V2_EXECUTION_DEPLOYMENTS.find(
    (deployment) => deployment.source === "pancakeswap-v2",
  )!;
  const profile = {
    ...buildMeasuredProfile({
      replay,
      target,
      points,
      factoryAddress: pancakeDeployment.factoryAddress,
      factoryCodeHash: pancakeDeployment.expectedFactoryCodeHash,
    }),
  };

  return {
    profile,
    profileV2: projectDexMeasuredExecutionProfileToV2(profile),
    capacityCurve,
  };
}

function buildMeasuredProfile(input: {
  replay: EvmV2ReplayCase;
  target: DexMeasuredExecutionTarget;
  points: DexMeasuredExecutionQuotePointProof[];
  factoryAddress: `0x${string}`;
  factoryCodeHash: `0x${string}`;
}): DexMeasuredExecutionProfile {
  const callData = `0xe6a43905${addressWord(input.replay.stablecoinAddress).slice(2)}${addressWord(
    input.replay.counterAddress,
  ).slice(2)}`;
  return buildDexMeasuredExecutionProfile({
    target: input.target,
    targetGenerationId: "evm-v2-fixture-targets",
    quoteGenerationId: "evm-v2-fixture-quotes",
    quotedAt: input.target.capturedAt + 1,
    blockNumber: EVM_V2_REPLAY_BLOCK,
    endpointAddress: input.replay.poolAddress,
    endpointCodeHash: `0x${"ab".repeat(32)}`,
    poolBindingProof: {
      factoryAddress: input.factoryAddress,
      factoryCodeHash: input.factoryCodeHash,
      resolvedPoolAddress: input.replay.poolAddress,
      callData,
      returnData: addressWord(input.replay.poolAddress),
    },
    points: input.points,
  });
}
