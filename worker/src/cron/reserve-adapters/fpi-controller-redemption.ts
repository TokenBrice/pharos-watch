import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { EvmMulticall3Call, EvmMulticall3Result, EvmRpcOptions } from "../../lib/evm-rpc";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
} from "../../lib/evm-rpc";
import { rethrowIfAborted } from "../../lib/abort";
import {
  FpiControllerV9RouteAttemptSchema,
  type FpiControllerV9RouteAttempt,
} from "../../lib/fpi-controller-redemption-route";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";

type FpiParams = LiveReserveAdapterParamsByKey["frax-fpi-collateral"];

const CHAIN = "ethereum";
const BLOCK_MAX_AGE_SEC = 5 * 60;
const BLOCK_FUTURE_SKEW_SEC = 60;
const RPC_DEADLINE_MS = 8_000;
const TOKEN_SCALE = 10n ** 18n;
const FEE_SCALE = 1_000_000n;
const QUOTE_INPUT_RAW = TOKEN_SCALE;

const CONTROLLER_ABI = parseAbi([
  "function FPI_TKN() view returns (address)",
  "function FRAX() view returns (address)",
  "function priceFeedFRAXUSD() view returns (address)",
  "function priceFeedFPIUSD() view returns (address)",
  "function cpiTracker() view returns (address)",
  "function chainlink_frax_usd_decimals() view returns (uint256)",
  "function chainlink_fpi_usd_decimals() view returns (uint256)",
  "function redeem_fee() view returns (uint256)",
  "function redeems_paused() view returns (bool)",
  "function peg_band_mint_redeem() view returns (uint256)",
  "function pegStatusMntRdm() view returns (uint256 cpiPegPrice, uint256 diffFracAbs, bool withinRange)",
  "function calcRedeemFPI(uint256 fpiIn, uint256 minFraxOut) view returns (uint256 fraxOut)",
  "function getFRAXPriceE18() view returns (uint256)",
  "function getFPIPriceE18() view returns (uint256)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const PRICE_FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const CPI_TRACKER_ABI = parseAbi([
  "function currPegPrice() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
]);

interface FpiControllerRouteReadClient {
  blockNumber(options: EvmRpcOptions): Promise<number | null>;
  blockTimestamp(blockNumber: number, options: EvmRpcOptions): Promise<number | null>;
  code(address: string, blockNumber: number, options: EvmRpcOptions): Promise<Hex | null>;
  multicall(
    calls: readonly EvmMulticall3Call[],
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<EvmMulticall3Result[] | null>;
  call(address: string, data: string, blockNumber: number, options: EvmRpcOptions): Promise<Hex | null>;
}

const DEFAULT_CLIENT: FpiControllerRouteReadClient = {
  blockNumber: (options) => fetchEvmBlockNumber(CHAIN, options),
  blockTimestamp: (blockNumber, options) => fetchEvmBlockTimestamp(CHAIN, blockNumber, options),
  code: (address, blockNumber, options) => fetchEvmCodeAtBlock(CHAIN, address, blockNumber, options),
  multicall: (calls, blockNumber, options) =>
    fetchEvmMulticall3Aggregate3AtBlock(CHAIN, calls, blockNumber, options),
  call: (address, data, blockNumber, options) =>
    fetchEvmCallHexAtBlock(CHAIN, address, data, blockNumber, options),
};

function rejected(
  attemptedAtSec: number,
  rejectionCode: Extract<FpiControllerV9RouteAttempt, { status: "rejected" }>["rejectionCode"],
  blockNumber?: number,
): FpiControllerV9RouteAttempt {
  return FpiControllerV9RouteAttemptSchema.parse({
    status: "rejected",
    attemptedAtSec,
    rejectionCode,
    ...(blockNumber != null ? { blockNumber } : {}),
  });
}

function resultByLabel(results: readonly EvmMulticall3Result[], label: string): Hex | null {
  const result = results.find((candidate) => candidate.label === label);
  return result?.success && result.returnData !== "0x" ? result.returnData : null;
}

type ControllerFunctionName =
  | "FPI_TKN"
  | "FRAX"
  | "priceFeedFRAXUSD"
  | "priceFeedFPIUSD"
  | "cpiTracker"
  | "chainlink_frax_usd_decimals"
  | "chainlink_fpi_usd_decimals"
  | "redeem_fee"
  | "redeems_paused"
  | "peg_band_mint_redeem"
  | "pegStatusMntRdm"
  | "calcRedeemFPI"
  | "getFRAXPriceE18"
  | "getFPIPriceE18";

function decodeResult(
  results: readonly EvmMulticall3Result[],
  label: string,
  functionName: ControllerFunctionName,
): unknown {
  const data = resultByLabel(results, label);
  if (!data) return null;
  try {
    return decodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName,
      data,
    } as Parameters<typeof decodeFunctionResult>[0]);
  } catch {
    return null;
  }
}

function decodePriceFeedResult(
  results: readonly EvmMulticall3Result[],
  label: string,
  functionName: "decimals" | "latestRoundData",
): unknown {
  const data = resultByLabel(results, label);
  if (!data) return null;
  try {
    return decodeFunctionResult({
      abi: PRICE_FEED_ABI,
      functionName,
      data,
    } as Parameters<typeof decodeFunctionResult>[0]);
  } catch {
    return null;
  }
}

function decodeCpiTrackerResult(
  results: readonly EvmMulticall3Result[],
  label: string,
  functionName: "currPegPrice" | "lastUpdateTime",
): unknown {
  const data = resultByLabel(results, label);
  if (!data) return null;
  try {
    return decodeFunctionResult({
      abi: CPI_TRACKER_ABI,
      functionName,
      data,
    } as Parameters<typeof decodeFunctionResult>[0]);
  } catch {
    return null;
  }
}

function decodeBalance(results: readonly EvmMulticall3Result[]): bigint | null {
  const data = resultByLabel(results, "controller-frax-balance");
  if (!data) return null;
  try {
    const decoded = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      data,
    });
    return typeof decoded === "bigint" ? decoded : null;
  } catch {
    return null;
  }
}

function expectedRedeemOutput(inputRaw: bigint, pegPriceRaw: bigint, feeRaw: bigint): bigint | null {
  if (inputRaw <= 0 || pegPriceRaw <= 0 || feeRaw < 0 || feeRaw >= FEE_SCALE) return null;
  const beforeFee = (inputRaw * pegPriceRaw) / TOKEN_SCALE;
  return beforeFee - (beforeFee * feeRaw) / FEE_SCALE;
}

function toTokenUnits(raw: bigint): number {
  return Number(raw) / Number(TOKEN_SCALE);
}

interface DecodedPriceFeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

function decodePriceFeedRound(
  results: readonly EvmMulticall3Result[],
  label: string,
): DecodedPriceFeedRound | null {
  const decoded = decodePriceFeedResult(results, label, "latestRoundData");
  if (
    !Array.isArray(decoded) ||
    typeof decoded[0] !== "bigint" ||
    typeof decoded[1] !== "bigint" ||
    typeof decoded[3] !== "bigint" ||
    typeof decoded[4] !== "bigint"
  ) {
    return null;
  }
  return {
    roundId: decoded[0],
    answer: decoded[1],
    updatedAt: decoded[3],
    answeredInRound: decoded[4],
  };
}

function normalizeFeedAnswerE18(answer: bigint, decimals: bigint): bigint | null {
  if (answer <= 0 || decimals < 0 || decimals > 36) return null;
  return (answer * TOKEN_SCALE) / (10n ** decimals);
}

function toSafeTimestamp(value: bigint): number | null {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function isPriceFeedRoundFreshAtBlock(
  round: DecodedPriceFeedRound,
  blockTimestamp: number,
  maxAgeSec: number,
): boolean {
  const updatedAt = toSafeTimestamp(round.updatedAt);
  return (
    updatedAt != null &&
    updatedAt <= blockTimestamp + BLOCK_FUTURE_SKEW_SEC &&
    blockTimestamp - updatedAt <= maxAgeSec
  );
}

function expectedPegDifferenceE6(fpiPriceRaw: bigint, pegPriceRaw: bigint): bigint | null {
  if (fpiPriceRaw <= 0 || pegPriceRaw <= 0) return null;
  return fpiPriceRaw > pegPriceRaw
    ? ((fpiPriceRaw - pegPriceRaw) * FEE_SCALE) / fpiPriceRaw
    : ((pegPriceRaw - fpiPriceRaw) * FEE_SCALE) / fpiPriceRaw;
}

function buildCalls(params: FpiParams): EvmMulticall3Call[] {
  return [
    {
      label: "controller-fpi-token",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "FPI_TKN" }),
      allowFailure: false,
    },
    {
      label: "controller-frax-price-feed",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "priceFeedFRAXUSD" }),
      allowFailure: false,
    },
    {
      label: "controller-fpi-price-feed",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "priceFeedFPIUSD" }),
      allowFailure: false,
    },
    {
      label: "controller-cpi-tracker",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "cpiTracker" }),
      allowFailure: false,
    },
    {
      label: "controller-frax-feed-decimals",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "chainlink_frax_usd_decimals" }),
      allowFailure: false,
    },
    {
      label: "controller-fpi-feed-decimals",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "chainlink_fpi_usd_decimals" }),
      allowFailure: false,
    },
    {
      label: "controller-frax-token",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "FRAX" }),
      allowFailure: false,
    },
    {
      label: "controller-fpi-price",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "getFPIPriceE18" }),
      allowFailure: false,
    },
    {
      label: "frax-price-feed-decimals",
      target: params.expectedFraxPriceFeedAddress,
      callData: encodeFunctionData({ abi: PRICE_FEED_ABI, functionName: "decimals" }),
      allowFailure: false,
    },
    {
      label: "frax-price-feed-round",
      target: params.expectedFraxPriceFeedAddress,
      callData: encodeFunctionData({ abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
      allowFailure: false,
    },
    {
      label: "fpi-price-feed-decimals",
      target: params.expectedFpiPriceFeedAddress,
      callData: encodeFunctionData({ abi: PRICE_FEED_ABI, functionName: "decimals" }),
      allowFailure: false,
    },
    {
      label: "fpi-price-feed-round",
      target: params.expectedFpiPriceFeedAddress,
      callData: encodeFunctionData({ abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
      allowFailure: false,
    },
    {
      label: "cpi-tracker-peg-price",
      target: params.expectedCpiTrackerAddress,
      callData: encodeFunctionData({ abi: CPI_TRACKER_ABI, functionName: "currPegPrice" }),
      allowFailure: false,
    },
    {
      label: "cpi-tracker-updated-at",
      target: params.expectedCpiTrackerAddress,
      callData: encodeFunctionData({ abi: CPI_TRACKER_ABI, functionName: "lastUpdateTime" }),
      allowFailure: false,
    },
    {
      label: "controller-redeem-fee",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "redeem_fee" }),
      allowFailure: false,
    },
    {
      label: "controller-redeems-paused",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "redeems_paused" }),
      allowFailure: false,
    },
    {
      label: "controller-peg-band",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "peg_band_mint_redeem" }),
      allowFailure: false,
    },
    {
      label: "controller-peg-status",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "pegStatusMntRdm" }),
      allowFailure: false,
    },
    {
      label: "controller-unit-redeem-quote",
      target: params.controllerAddress,
      callData: encodeFunctionData({
        abi: CONTROLLER_ABI,
        functionName: "calcRedeemFPI",
        args: [QUOTE_INPUT_RAW, 0n],
      }),
      allowFailure: false,
    },
    {
      label: "controller-frax-price",
      target: params.controllerAddress,
      callData: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: "getFRAXPriceE18" }),
      allowFailure: false,
    },
    {
      label: "controller-frax-balance",
      target: params.fraxTokenAddress,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [params.controllerAddress as Hex],
      }),
      allowFailure: false,
    },
  ];
}

async function observeWithClient(
  params: FpiParams,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
  attemptedAtSec: number,
  client: FpiControllerRouteReadClient,
): Promise<FpiControllerV9RouteAttempt> {
  const controllerAddress = normalizeEvmAddress(params.controllerAddress);
  const expectedFpiAddress = normalizeEvmAddress(params.fpiTokenAddress);
  const expectedFraxAddress = normalizeEvmAddress(params.fraxTokenAddress);
  const expectedFraxPriceFeedAddress = normalizeEvmAddress(params.expectedFraxPriceFeedAddress);
  const expectedFpiPriceFeedAddress = normalizeEvmAddress(params.expectedFpiPriceFeedAddress);
  const expectedCpiTrackerAddress = normalizeEvmAddress(params.expectedCpiTrackerAddress);
  if (
    !controllerAddress ||
    !expectedFpiAddress ||
    !expectedFraxAddress ||
    !expectedFraxPriceFeedAddress ||
    !expectedFpiPriceFeedAddress ||
    !expectedCpiTrackerAddress
  ) {
    return rejected(attemptedAtSec, "controller-state-invalid");
  }

  const rpcOptions: EvmRpcOptions = {
    extraRpcUrls: [params.rpcUrl, params.fallbackRpcUrl].filter((url): url is string => Boolean(url)),
    chainRpcs: ctx?.chainRpcs,
    signal,
    timeoutMs: 3_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };
  if ((rpcOptions.extraRpcUrls?.length ?? 0) === 0 && !rpcOptions.chainRpcs?.has(CHAIN)) {
    return rejected(attemptedAtSec, "rpc-unavailable");
  }

  const blockNumber = await runAdapterIo(
    ctx,
    "fpi-controller-block-number",
    () => client.blockNumber(rpcOptions),
    { signal },
  );
  if (blockNumber == null) return rejected(attemptedAtSec, "block-unavailable");

  const [blockTimestamp, controllerCode] = await Promise.all([
    runAdapterIo(
      ctx,
      "fpi-controller-block-timestamp",
      () => client.blockTimestamp(blockNumber, rpcOptions),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "fpi-controller-code",
      () => client.code(controllerAddress, blockNumber, rpcOptions),
      { signal },
    ),
  ]);
  if (
    blockTimestamp == null ||
    blockTimestamp < attemptedAtSec - BLOCK_MAX_AGE_SEC ||
    blockTimestamp > attemptedAtSec + BLOCK_FUTURE_SKEW_SEC
  ) {
    return rejected(attemptedAtSec, "block-time-out-of-range", blockNumber);
  }
  if (!controllerCode) {
    return rejected(attemptedAtSec, "controller-code-unavailable", blockNumber);
  }
  const controllerCodeHash = keccak256(controllerCode).toLowerCase();
  if (controllerCodeHash !== params.expectedControllerCodeHash.toLowerCase()) {
    return rejected(attemptedAtSec, "controller-code-drift", blockNumber);
  }

  const [fraxPriceFeedCode, fpiPriceFeedCode] = await Promise.all([
    runAdapterIo(
      ctx,
      "fpi-controller-frax-price-feed-code",
      () => client.code(expectedFraxPriceFeedAddress, blockNumber, rpcOptions),
      { signal },
    ),
    runAdapterIo(
      ctx,
      "fpi-controller-fpi-price-feed-code",
      () => client.code(expectedFpiPriceFeedAddress, blockNumber, rpcOptions),
      { signal },
    ),
  ]);
  const cpiTrackerCode = await runAdapterIo(
    ctx,
    "fpi-controller-cpi-tracker-code",
    () => client.code(expectedCpiTrackerAddress, blockNumber, rpcOptions),
    { signal },
  );
  if (!fraxPriceFeedCode || !fpiPriceFeedCode || !cpiTrackerCode) {
    return rejected(attemptedAtSec, "dependency-code-unavailable", blockNumber);
  }
  const fraxPriceFeedCodeHash = keccak256(fraxPriceFeedCode).toLowerCase();
  const fpiPriceFeedCodeHash = keccak256(fpiPriceFeedCode).toLowerCase();
  const cpiTrackerCodeHash = keccak256(cpiTrackerCode).toLowerCase();
  if (
    fraxPriceFeedCodeHash !== params.expectedFraxPriceFeedCodeHash.toLowerCase() ||
    fpiPriceFeedCodeHash !== params.expectedFpiPriceFeedCodeHash.toLowerCase() ||
    cpiTrackerCodeHash !== params.expectedCpiTrackerCodeHash.toLowerCase()
  ) {
    return rejected(attemptedAtSec, "dependency-code-drift", blockNumber);
  }

  const results = await runAdapterIo(
    ctx,
    "fpi-controller-state",
    () => client.multicall(buildCalls(params), blockNumber, rpcOptions),
    { signal },
  );
  if (!results) {
    return rejected(attemptedAtSec, "controller-state-unavailable", blockNumber);
  }

  const fpiAddress = normalizeEvmAddress(
    decodeResult(results, "controller-fpi-token", "FPI_TKN") as string | undefined,
  );
  const fraxAddress = normalizeEvmAddress(
    decodeResult(results, "controller-frax-token", "FRAX") as string | undefined,
  );
  const fraxPriceFeedAddress = normalizeEvmAddress(
    decodeResult(results, "controller-frax-price-feed", "priceFeedFRAXUSD") as string | undefined,
  );
  const fpiPriceFeedAddress = normalizeEvmAddress(
    decodeResult(results, "controller-fpi-price-feed", "priceFeedFPIUSD") as string | undefined,
  );
  const cpiTrackerAddress = normalizeEvmAddress(
    decodeResult(results, "controller-cpi-tracker", "cpiTracker") as string | undefined,
  );
  const controllerFraxFeedDecimals = decodeResult(
    results,
    "controller-frax-feed-decimals",
    "chainlink_frax_usd_decimals",
  );
  const controllerFpiFeedDecimals = decodeResult(
    results,
    "controller-fpi-feed-decimals",
    "chainlink_fpi_usd_decimals",
  );
  const feeRaw = decodeResult(results, "controller-redeem-fee", "redeem_fee");
  const paused = decodeResult(results, "controller-redeems-paused", "redeems_paused");
  const pegBandRaw = decodeResult(results, "controller-peg-band", "peg_band_mint_redeem");
  const pegStatus = decodeResult(results, "controller-peg-status", "pegStatusMntRdm");
  const unitQuoteRaw = decodeResult(results, "controller-unit-redeem-quote", "calcRedeemFPI");
  const outputPriceRaw = decodeResult(results, "controller-frax-price", "getFRAXPriceE18");
  const fpiPriceRaw = decodeResult(results, "controller-fpi-price", "getFPIPriceE18");
  const fraxFeedDecimals = decodePriceFeedResult(results, "frax-price-feed-decimals", "decimals");
  const fpiFeedDecimals = decodePriceFeedResult(results, "fpi-price-feed-decimals", "decimals");
  const fraxPriceRound = decodePriceFeedRound(results, "frax-price-feed-round");
  const fpiPriceRound = decodePriceFeedRound(results, "fpi-price-feed-round");
  const cpiTrackerPegPriceRaw = decodeCpiTrackerResult(
    results,
    "cpi-tracker-peg-price",
    "currPegPrice",
  );
  const cpiTrackerUpdatedAtRaw = decodeCpiTrackerResult(
    results,
    "cpi-tracker-updated-at",
    "lastUpdateTime",
  );
  const controllerBalanceRaw = decodeBalance(results);
  if (
    typeof controllerFraxFeedDecimals !== "bigint" ||
    typeof controllerFpiFeedDecimals !== "bigint" ||
    typeof feeRaw !== "bigint" ||
    typeof paused !== "boolean" ||
    typeof pegBandRaw !== "bigint" ||
    !Array.isArray(pegStatus) ||
    typeof pegStatus[0] !== "bigint" ||
    typeof pegStatus[1] !== "bigint" ||
    typeof pegStatus[2] !== "boolean" ||
    typeof unitQuoteRaw !== "bigint" ||
    typeof outputPriceRaw !== "bigint" ||
    typeof fpiPriceRaw !== "bigint" ||
    controllerBalanceRaw == null
  ) {
    return rejected(attemptedAtSec, "controller-state-invalid", blockNumber);
  }
  if (fpiAddress !== expectedFpiAddress || fraxAddress !== expectedFraxAddress) {
    return rejected(attemptedAtSec, "interface-identity-mismatch", blockNumber);
  }
  if (
    fraxPriceFeedAddress !== expectedFraxPriceFeedAddress ||
    fpiPriceFeedAddress !== expectedFpiPriceFeedAddress ||
    cpiTrackerAddress !== expectedCpiTrackerAddress
  ) {
    return rejected(attemptedAtSec, "oracle-identity-mismatch", blockNumber);
  }
  if (
    typeof fraxFeedDecimals !== "number" ||
    typeof fpiFeedDecimals !== "number" ||
    !Number.isInteger(fraxFeedDecimals) ||
    !Number.isInteger(fpiFeedDecimals) ||
    controllerFraxFeedDecimals !== BigInt(params.expectedFraxPriceFeedDecimals) ||
    controllerFpiFeedDecimals !== BigInt(params.expectedFpiPriceFeedDecimals) ||
    fraxFeedDecimals !== params.expectedFraxPriceFeedDecimals ||
    fpiFeedDecimals !== params.expectedFpiPriceFeedDecimals ||
    typeof cpiTrackerPegPriceRaw !== "bigint" ||
    typeof cpiTrackerUpdatedAtRaw !== "bigint"
  ) {
    return rejected(attemptedAtSec, "oracle-state-invalid", blockNumber);
  }
  const fraxPriceFeedUpdatedAt = fraxPriceRound
    ? toSafeTimestamp(fraxPriceRound.updatedAt)
    : null;
  const fpiPriceFeedUpdatedAt = fpiPriceRound
    ? toSafeTimestamp(fpiPriceRound.updatedAt)
    : null;
  if (
    !fraxPriceRound ||
    !fpiPriceRound ||
    fraxPriceRound.answer <= 0 ||
    fpiPriceRound.answer <= 0 ||
    fraxPriceRound.answeredInRound < fraxPriceRound.roundId ||
    fpiPriceRound.answeredInRound < fpiPriceRound.roundId ||
    fraxPriceFeedUpdatedAt == null ||
    fpiPriceFeedUpdatedAt == null
  ) {
    return rejected(attemptedAtSec, "oracle-round-invalid", blockNumber);
  }
  if (
    !isPriceFeedRoundFreshAtBlock(fraxPriceRound, blockTimestamp, params.maxPriceFeedAgeSec) ||
    !isPriceFeedRoundFreshAtBlock(fpiPriceRound, blockTimestamp, params.maxPriceFeedAgeSec)
  ) {
    return rejected(attemptedAtSec, "oracle-stale", blockNumber);
  }
  const directFraxPriceRaw = normalizeFeedAnswerE18(
    fraxPriceRound.answer,
    BigInt(fraxFeedDecimals),
  );
  const directFpiPriceRaw = normalizeFeedAnswerE18(
    fpiPriceRound.answer,
    BigInt(fpiFeedDecimals),
  );
  if (
    directFraxPriceRaw == null ||
    directFpiPriceRaw == null ||
    outputPriceRaw !== directFraxPriceRaw ||
    fpiPriceRaw !== directFpiPriceRaw
  ) {
    return rejected(attemptedAtSec, "controller-oracle-disagreement", blockNumber);
  }
  const cpiTrackerUpdatedAt = toSafeTimestamp(cpiTrackerUpdatedAtRaw);
  if (
    cpiTrackerPegPriceRaw <= 0 ||
    cpiTrackerUpdatedAt == null ||
    cpiTrackerUpdatedAt > blockTimestamp + BLOCK_FUTURE_SKEW_SEC
  ) {
    return rejected(attemptedAtSec, "cpi-tracker-state-invalid", blockNumber);
  }
  const fraxPriceFeedAgeSec = Math.max(0, blockTimestamp - fraxPriceFeedUpdatedAt);
  const fpiPriceFeedAgeSec = Math.max(0, blockTimestamp - fpiPriceFeedUpdatedAt);
  const cpiTrackerAgeSec = Math.max(0, blockTimestamp - cpiTrackerUpdatedAt);
  if (cpiTrackerAgeSec > params.maxCpiTrackerAgeSec) {
    return rejected(attemptedAtSec, "cpi-tracker-stale", blockNumber);
  }
  if (feeRaw !== BigInt(params.expectedRedeemFeeE6)) {
    return rejected(attemptedAtSec, "fee-drift", blockNumber);
  }
  if (paused) return rejected(attemptedAtSec, "redemption-paused", blockNumber);

  const [pegPriceRaw, pegDifferenceRaw, withinPegBand] = pegStatus as [bigint, bigint, boolean];
  const expectedPegDifferenceRaw = expectedPegDifferenceE6(fpiPriceRaw, cpiTrackerPegPriceRaw);
  if (
    expectedPegDifferenceRaw == null ||
    pegPriceRaw !== cpiTrackerPegPriceRaw ||
    pegDifferenceRaw !== expectedPegDifferenceRaw ||
    withinPegBand !== (expectedPegDifferenceRaw <= pegBandRaw)
  ) {
    return rejected(attemptedAtSec, "controller-oracle-disagreement", blockNumber);
  }
  if (!withinPegBand || pegPriceRaw <= 0 || pegDifferenceRaw > pegBandRaw) {
    return rejected(attemptedAtSec, "peg-band-invalid", blockNumber);
  }
  const expectedUnitQuoteRaw = expectedRedeemOutput(QUOTE_INPUT_RAW, pegPriceRaw, feeRaw);
  if (expectedUnitQuoteRaw == null || unitQuoteRaw !== expectedUnitQuoteRaw) {
    return rejected(attemptedAtSec, "calculation-mismatch", blockNumber);
  }

  const outputPriceUsd = toTokenUnits(outputPriceRaw);
  if (
    !Number.isFinite(outputPriceUsd) ||
    outputPriceUsd < params.minOutputPriceUsd ||
    outputPriceUsd > params.maxOutputPriceUsd
  ) {
    return rejected(attemptedAtSec, "output-price-invalid", blockNumber);
  }
  const outputValueRaw = (unitQuoteRaw * outputPriceRaw) / TOKEN_SCALE;
  const allInCostBps =
    outputValueRaw >= pegPriceRaw
      ? 0
      : (Number(pegPriceRaw - outputValueRaw) / Number(pegPriceRaw)) * 10_000;
  if (
    !Number.isFinite(allInCostBps) ||
    allInCostBps > SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps
  ) {
    return rejected(attemptedAtSec, "all-in-cost-exceeds-request", blockNumber);
  }
  if (controllerBalanceRaw < unitQuoteRaw || controllerBalanceRaw <= 0) {
    return rejected(attemptedAtSec, "capacity-unavailable", blockNumber);
  }

  const capacityDenominator = pegPriceRaw * (FEE_SCALE - feeRaw);
  if (capacityDenominator <= 0) {
    return rejected(attemptedAtSec, "capacity-unavailable", blockNumber);
  }
  let maxInputRaw = (controllerBalanceRaw * TOKEN_SCALE * FEE_SCALE) / capacityDenominator;
  let expectedCapacityOutputRaw = expectedRedeemOutput(maxInputRaw, pegPriceRaw, feeRaw);
  while (maxInputRaw > 0 && expectedCapacityOutputRaw != null && expectedCapacityOutputRaw > controllerBalanceRaw) {
    maxInputRaw -= 1n;
    expectedCapacityOutputRaw = expectedRedeemOutput(maxInputRaw, pegPriceRaw, feeRaw);
  }
  if (maxInputRaw <= 0 || expectedCapacityOutputRaw == null) {
    return rejected(attemptedAtSec, "capacity-unavailable", blockNumber);
  }

  const capacityQuoteData = await runAdapterIo(
    ctx,
    "fpi-controller-capacity-quote",
    () =>
      client.call(
        controllerAddress,
        encodeFunctionData({
          abi: CONTROLLER_ABI,
          functionName: "calcRedeemFPI",
          args: [maxInputRaw, 0n],
        }),
        blockNumber,
        rpcOptions,
      ),
    { signal },
  );
  if (!capacityQuoteData) {
    return rejected(attemptedAtSec, "capacity-unavailable", blockNumber);
  }
  let capacityOutputRaw: bigint | null = null;
  try {
    const decoded = decodeFunctionResult({
      abi: CONTROLLER_ABI,
      functionName: "calcRedeemFPI",
      data: capacityQuoteData,
    });
    capacityOutputRaw = typeof decoded === "bigint" ? decoded : null;
  } catch {
    capacityOutputRaw = null;
  }
  if (
    capacityOutputRaw == null ||
    capacityOutputRaw !== expectedCapacityOutputRaw ||
    capacityOutputRaw > controllerBalanceRaw ||
    controllerBalanceRaw - capacityOutputRaw > unitQuoteRaw
  ) {
    return rejected(attemptedAtSec, "capacity-mismatch", blockNumber);
  }

  const maxRedeemableFpi = toTokenUnits(maxInputRaw);
  const pegPriceUsd = toTokenUnits(pegPriceRaw);
  const fpiPriceUsd = toTokenUnits(fpiPriceRaw);
  const capacityUsd = maxRedeemableFpi * pegPriceUsd;
  const cpiTrackerFreshness =
    cpiTrackerAgeSec <= params.fullConfidenceCpiTrackerAgeSec
      ? "current"
      : "stale-bounded";
  const modelConfidence = cpiTrackerFreshness === "current" ? "high" : "medium";
  return FpiControllerV9RouteAttemptSchema.parse({
    status: "accepted",
    attemptedAtSec,
    state: {
      kind: "fpi-controller-v1",
      chain: CHAIN,
      controllerAddress,
      controllerCodeHash,
      blockNumber,
      blockTimestamp,
      inputTokenAddress: expectedFpiAddress,
      outputTokenAddress: expectedFraxAddress,
      outputTrackedAssetId: params.outputTrackedAssetId,
      fraxPriceFeedAddress: expectedFraxPriceFeedAddress,
      fraxPriceFeedCodeHash,
      fraxPriceFeedRoundId: fraxPriceRound.roundId.toString(),
      fraxPriceFeedUpdatedAt,
      fraxPriceFeedAgeSec,
      fpiPriceFeedAddress: expectedFpiPriceFeedAddress,
      fpiPriceFeedCodeHash,
      fpiPriceFeedRoundId: fpiPriceRound.roundId.toString(),
      fpiPriceFeedUpdatedAt,
      fpiPriceFeedAgeSec,
      maxPriceFeedAgeSec: params.maxPriceFeedAgeSec,
      cpiTrackerAddress: expectedCpiTrackerAddress,
      cpiTrackerCodeHash,
      cpiTrackerUpdatedAt,
      cpiTrackerAgeSec,
      fullConfidenceCpiTrackerAgeSec: params.fullConfidenceCpiTrackerAgeSec,
      maxCpiTrackerAgeSec: params.maxCpiTrackerAgeSec,
      cpiTrackerFreshness,
      modelConfidence,
      feeBps: Number(feeRaw) / 100,
      pegPriceUsd,
      fpiPriceUsd,
      pegDifferenceBps: Number(pegDifferenceRaw) / 100,
      pegBandBps: Number(pegBandRaw) / 100,
      quoteInputFpi: toTokenUnits(QUOTE_INPUT_RAW),
      quoteOutputFrax: toTokenUnits(unitQuoteRaw),
      outputPriceUsd,
      allInCostBps,
      controllerOutputBalance: toTokenUnits(controllerBalanceRaw),
      maxRedeemableFpi,
      capacityUsd,
      sourceUrls: params.sourceUrls,
    },
  });
}

export async function observeFpiControllerRedemptionRoute(
  params: FpiParams,
  signal: AbortSignal,
  ctx?: AdapterContext,
  options: {
    attemptedAtSec?: number;
    client?: FpiControllerRouteReadClient;
  } = {},
): Promise<FpiControllerV9RouteAttempt> {
  const attemptedAtSec = Math.floor(options.attemptedAtSec ?? Date.now() / 1_000);
  try {
    return await observeWithClient(params, signal, ctx, attemptedAtSec, options.client ?? DEFAULT_CLIENT);
  } catch (error) {
    rethrowIfAborted(error, signal);
    return rejected(attemptedAtSec, "rpc-unavailable");
  }
}

export type { FpiControllerRouteReadClient };
