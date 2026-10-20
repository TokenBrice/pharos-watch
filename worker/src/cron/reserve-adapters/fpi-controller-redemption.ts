import type { LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { Abi, ExtractAbiFunctionNames } from "abitype";
import { SAME_NOTIONAL_EXIT_REQUEST_POLICY } from "@shared/lib/redemption-backstop-scoring";
import type { EvmMulticall3Call, EvmMulticall3Result, EvmRpcOptions } from "../../lib/evm-rpc";
import {
  fetchEvmBlockNumber,
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
} from "../../lib/evm-rpc";
import { getChainRpc, hasRegistryRpc } from "../../lib/chain-registry";
import { rethrowIfAborted } from "../../lib/abort";
import {
  FpiControllerV9RouteAttemptSchema,
  type FpiControllerV9RouteAttempt,
} from "../../lib/fpi-controller-redemption-route";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type DecodeFunctionResultParameters,
  type DecodeFunctionResultReturnType,
} from "viem/utils";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import { runtimeCodeHash } from "./onchain-identity";
import {
  abiObservation,
  codeIdentityChecks,
  customObservation,
  executeEvmObservationPlan,
} from "./evm-observation-plan";

type FpiParams = LiveReserveAdapterParamsByKey["frax-fpi-collateral"];
type Hex = `0x${string}`;

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

function fpiObservation<
  const Label extends string,
  const ABI extends Abi,
  const Function extends ExtractAbiFunctionNames<ABI, "view"> & NonNullable<DecodeFunctionResultParameters<ABI>["functionName"]>,
>(label: Label, contract: string, abi: ABI, functionName: Function, args?: readonly unknown[]) {
  const field = abiObservation({ label, contract, abi, functionName, args, optional: true });
  return customObservation({
    ...field,
    // Keep ABI decoding and nullable failures: the controller, identity and
    // oracle policies below own both rejection precedence and reason codes.
    decode: (raw, observedLabel): DecodeFunctionResultReturnType<ABI, Function> | null => {
      try {
        return field.decode(raw, observedLabel) as DecodeFunctionResultReturnType<ABI, Function>;
      } catch {
        return null;
      }
    },
  });
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
  decoded: readonly [bigint, bigint, bigint, bigint, bigint] | null,
): DecodedPriceFeedRound | null {
  if (!decoded) return null;
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

  const chainRpcs = ctx?.chainRpcs;
  const rpcOptions: EvmRpcOptions = {
    extraRpcUrls: [params.rpcUrl, params.fallbackRpcUrl].filter((url): url is string => Boolean(url)),
    chainRpcs,
    signal,
    timeoutMs: 3_000,
    deadlineMs: Date.now() + RPC_DEADLINE_MS,
    maxRetries: 0,
  };
  // A supplemental-only config is not a registry read path, so it cannot make
  // this route available.
  if (
    (rpcOptions.extraRpcUrls?.length ?? 0) === 0 &&
    !hasRegistryRpc(chainRpcs ? getChainRpc(chainRpcs, CHAIN) : undefined)
  ) {
    return rejected(attemptedAtSec, "rpc-unavailable");
  }

  const blockNumber = await runAdapterIo(
    ctx,
    "fpi-controller-block-number",
    () => client.blockNumber(rpcOptions),
    { signal },
  );
  if (blockNumber == null) return rejected(attemptedAtSec, "block-unavailable");

  const checkIdentities = (identities: readonly { address: string; codeHash: string; label: string }[]) =>
    codeIdentityChecks(client, identities, {
      blockNumber,
      rpcOptions,
      parallel: true,
      readCode: async (readClient, address, block, options) =>
        (await readClient.code(address, block, options)) || null,
      readStorage: async () => { throw new Error("FPI identity checks require direct contracts, not proxy slots"); },
      hashCode: (code) => runtimeCodeHash(code as Hex),
      codeLabel: (identity) => identity.label,
      run: (label, factory) => runAdapterIo(ctx, label, factory, { signal }),
    });
  const [blockTimestamp, controllerIdentity] = await Promise.all([
    runAdapterIo(
      ctx,
      "fpi-controller-block-timestamp",
      () => client.blockTimestamp(blockNumber, rpcOptions),
      { signal },
    ),
    checkIdentities([{
      address: controllerAddress,
      codeHash: params.expectedControllerCodeHash,
      label: "fpi-controller-code",
    }]),
  ]);
  if (
    blockTimestamp == null ||
    blockTimestamp < attemptedAtSec - BLOCK_MAX_AGE_SEC ||
    blockTimestamp > attemptedAtSec + BLOCK_FUTURE_SKEW_SEC
  ) {
    return rejected(attemptedAtSec, "block-time-out-of-range", blockNumber);
  }
  if (controllerIdentity.status === "rejected") {
    return rejected(attemptedAtSec, controllerIdentity.rejectionCode === "code-unavailable"
      ? "controller-code-unavailable" : "controller-code-drift", blockNumber);
  }
  const feedIdentities = await checkIdentities([
    { address: expectedFraxPriceFeedAddress, codeHash: params.expectedFraxPriceFeedCodeHash, label: "fpi-controller-frax-price-feed-code" },
    { address: expectedFpiPriceFeedAddress, codeHash: params.expectedFpiPriceFeedCodeHash, label: "fpi-controller-fpi-price-feed-code" },
  ]);
  const cpiIdentity = await checkIdentities([
    { address: expectedCpiTrackerAddress, codeHash: params.expectedCpiTrackerCodeHash, label: "fpi-controller-cpi-tracker-code" },
  ]);
  const dependencyFailures = [feedIdentities, cpiIdentity].filter((result) => result.status === "rejected");
  if (dependencyFailures.length > 0) {
    return rejected(attemptedAtSec, dependencyFailures.some((result) => result.rejectionCode === "code-unavailable")
      ? "dependency-code-unavailable" : "dependency-code-drift", blockNumber);
  }
  const controllerCodeHash = params.expectedControllerCodeHash.toLowerCase();
  const fraxPriceFeedCodeHash = params.expectedFraxPriceFeedCodeHash.toLowerCase();
  const fpiPriceFeedCodeHash = params.expectedFpiPriceFeedCodeHash.toLowerCase();
  const cpiTrackerCodeHash = params.expectedCpiTrackerCodeHash.toLowerCase();

  let readCompleted = false;
  let stateAvailable = false;
  const observation = await executeEvmObservationPlan({
    adapterKey: "fpi-controller",
    fields: [
      fpiObservation("controller-fpi-token", params.controllerAddress, CONTROLLER_ABI, "FPI_TKN"),
      fpiObservation("controller-frax-price-feed", params.controllerAddress, CONTROLLER_ABI, "priceFeedFRAXUSD"),
      fpiObservation("controller-fpi-price-feed", params.controllerAddress, CONTROLLER_ABI, "priceFeedFPIUSD"),
      fpiObservation("controller-cpi-tracker", params.controllerAddress, CONTROLLER_ABI, "cpiTracker"),
      fpiObservation("controller-frax-feed-decimals", params.controllerAddress, CONTROLLER_ABI, "chainlink_frax_usd_decimals"),
      fpiObservation("controller-fpi-feed-decimals", params.controllerAddress, CONTROLLER_ABI, "chainlink_fpi_usd_decimals"),
      fpiObservation("controller-frax-token", params.controllerAddress, CONTROLLER_ABI, "FRAX"),
      fpiObservation("controller-fpi-price", params.controllerAddress, CONTROLLER_ABI, "getFPIPriceE18"),
      fpiObservation("frax-price-feed-decimals", params.expectedFraxPriceFeedAddress, PRICE_FEED_ABI, "decimals"),
      fpiObservation("frax-price-feed-round", params.expectedFraxPriceFeedAddress, PRICE_FEED_ABI, "latestRoundData"),
      fpiObservation("fpi-price-feed-decimals", params.expectedFpiPriceFeedAddress, PRICE_FEED_ABI, "decimals"),
      fpiObservation("fpi-price-feed-round", params.expectedFpiPriceFeedAddress, PRICE_FEED_ABI, "latestRoundData"),
      fpiObservation("cpi-tracker-peg-price", params.expectedCpiTrackerAddress, CPI_TRACKER_ABI, "currPegPrice"),
      fpiObservation("cpi-tracker-updated-at", params.expectedCpiTrackerAddress, CPI_TRACKER_ABI, "lastUpdateTime"),
      fpiObservation("controller-redeem-fee", params.controllerAddress, CONTROLLER_ABI, "redeem_fee"),
      fpiObservation("controller-redeems-paused", params.controllerAddress, CONTROLLER_ABI, "redeems_paused"),
      fpiObservation("controller-peg-band", params.controllerAddress, CONTROLLER_ABI, "peg_band_mint_redeem"),
      fpiObservation("controller-peg-status", params.controllerAddress, CONTROLLER_ABI, "pegStatusMntRdm"),
      fpiObservation("controller-unit-redeem-quote", params.controllerAddress, CONTROLLER_ABI, "calcRedeemFPI", [QUOTE_INPUT_RAW, 0n]),
      fpiObservation("controller-frax-price", params.controllerAddress, CONTROLLER_ABI, "getFRAXPriceE18"),
      fpiObservation("controller-frax-balance", params.fraxTokenAddress, ERC20_ABI, "balanceOf", [params.controllerAddress as Hex]),
    ],
    read: async (calls) => {
      const results = await runAdapterIo(ctx, "fpi-controller-state", () =>
        client.multicall(calls.map(({ label, contract, data, allowFailure }) => ({
          label, target: contract, callData: data, allowFailure,
        })), blockNumber, rpcOptions), { signal });
      readCompleted = true;
      stateAvailable = results != null;
      if (!results || results.length >= calls.length) return results;
      // A missing optional observation keeps its original local rejection
      // class. Duplicate/unknown labels still fail the shared plan's census.
      const seen = new Set(results.map(({ label }) => label));
      return [...results, ...calls.filter(({ label }) => !seen.has(label)).map(({ label }) => ({
        label, success: false, returnData: "0x" as const,
      }))];
    },
  }).catch((error: unknown) => {
    if (!readCompleted) throw error;
    return null;
  });
  if (!observation) {
    return rejected(attemptedAtSec, stateAvailable ? "controller-state-invalid" : "controller-state-unavailable", blockNumber);
  }
  const {
    "controller-fpi-token": fpiAddress,
    "controller-frax-token": fraxAddress,
    "controller-frax-price-feed": fraxPriceFeedAddress,
    "controller-fpi-price-feed": fpiPriceFeedAddress,
    "controller-cpi-tracker": cpiTrackerAddress,
    "controller-frax-feed-decimals": controllerFraxFeedDecimals,
    "controller-fpi-feed-decimals": controllerFpiFeedDecimals,
    "controller-redeem-fee": feeRaw,
    "controller-redeems-paused": paused,
    "controller-peg-band": pegBandRaw,
    "controller-peg-status": pegStatus,
    "controller-unit-redeem-quote": unitQuoteRaw,
    "controller-frax-price": outputPriceRaw,
    "controller-fpi-price": fpiPriceRaw,
    "frax-price-feed-decimals": fraxFeedDecimals,
    "fpi-price-feed-decimals": fpiFeedDecimals,
    "cpi-tracker-peg-price": cpiTrackerPegPriceRaw,
    "cpi-tracker-updated-at": cpiTrackerUpdatedAtRaw,
    "controller-frax-balance": controllerBalanceRaw,
  } = observation.values;
  const fraxPriceRound = decodePriceFeedRound(observation.values["frax-price-feed-round"]);
  const fpiPriceRound = decodePriceFeedRound(observation.values["fpi-price-feed-round"]);
  if (
    controllerFraxFeedDecimals == null ||
    controllerFpiFeedDecimals == null ||
    feeRaw == null ||
    paused == null ||
    pegBandRaw == null ||
    pegStatus == null ||
    unitQuoteRaw == null ||
    outputPriceRaw == null ||
    fpiPriceRaw == null ||
    controllerBalanceRaw == null
  ) {
    return rejected(attemptedAtSec, "controller-state-invalid", blockNumber);
  }
  if (normalizeEvmAddress(fpiAddress ?? undefined) !== expectedFpiAddress ||
      normalizeEvmAddress(fraxAddress ?? undefined) !== expectedFraxAddress) {
    return rejected(attemptedAtSec, "interface-identity-mismatch", blockNumber);
  }
  if (
    normalizeEvmAddress(fraxPriceFeedAddress ?? undefined) !== expectedFraxPriceFeedAddress ||
    normalizeEvmAddress(fpiPriceFeedAddress ?? undefined) !== expectedFpiPriceFeedAddress ||
    normalizeEvmAddress(cpiTrackerAddress ?? undefined) !== expectedCpiTrackerAddress
  ) {
    return rejected(attemptedAtSec, "oracle-identity-mismatch", blockNumber);
  }
  if (
    fraxFeedDecimals == null ||
    fpiFeedDecimals == null ||
    controllerFraxFeedDecimals !== BigInt(params.expectedFraxPriceFeedDecimals) ||
    controllerFpiFeedDecimals !== BigInt(params.expectedFpiPriceFeedDecimals) ||
    fraxFeedDecimals !== params.expectedFraxPriceFeedDecimals ||
    fpiFeedDecimals !== params.expectedFpiPriceFeedDecimals ||
    cpiTrackerPegPriceRaw == null ||
    cpiTrackerUpdatedAtRaw == null
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

  const [pegPriceRaw, pegDifferenceRaw, withinPegBand] = pegStatus;
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
