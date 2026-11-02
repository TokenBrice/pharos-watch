import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { canonicalExitRouteScopedId } from "@shared/types/exit-route-identity";
import { DEX_MEASURED_FRESHNESS_MAX_SEC } from "@shared/types/measured-execution";
import { decodeAbiParameters } from "viem/utils";

import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  type EvmBlockHeader,
  type EvmMulticall3Result,
  type EvmRpcOptions,
  type RecentFinalizedRpcPin,
} from "../../lib/evm-rpc";

const CURVE_STABLESWAP_FEE_DENOMINATOR = 10n ** 10n;
/** Keeps a pin valid through one in-flight request past the capture deadline. */
const RECENT_PIN_EXPIRY_MARGIN_SEC = 60;
/**
 * A finalized capture may only replace a near-head one: BSC/Monad finalize
 * within seconds, while zkSync's finalized head trails by hours and must keep
 * the latest-head capture.
 */
const RECENT_FINALIZED_CAPTURE_MAX_LAG_SEC = 300;
export type PinnedCaptureCheck<TFailure> = { ok: true } | { ok: false; reason?: TFailure };

export type PinnedCaptureResult<TResult, TFailure> =
  | { ok: true; value: TResult }
  | { ok: false; reason?: TFailure };

interface PinnedBlockCaptureContext {
  blockNumber: number;
  header: EvmBlockHeader;
  /** Base options plus `recentStatePin` when this capture reads recent-only Dwellir state. */
  rpcOptions: EvmRpcOptions;
}

function hasRecentOnlyDwellirRoute(chain: string, rpcOptions: EvmRpcOptions): boolean {
  const endpoints = rpcOptions.chainRpcs?.get(chain)?.endpoints ?? [];
  return endpoints.some((endpoint) =>
    endpoint.operator === "dwellir" && !endpoint.routingDisabled &&
    endpoint.stateHistory === "recent" && !endpoint.finalizedTagUnsupported);
}

/**
 * Recent-only Dwellir state serves the authenticated finalized block, not an
 * arbitrary numbered head. Return a pin only when that header is fresh now and
 * cannot be future-dated; otherwise the caller keeps today's latest-head read.
 */
async function resolveRecentStateCapture(input: {
  chain: string;
  rpcOptions: EvmRpcOptions;
  fetchBlockHeader: typeof fetchEvmBlockHeader;
  nowSec: number;
  maxAgeSec: number;
}): Promise<{ header: EvmBlockHeader; pin: RecentFinalizedRpcPin } | null> {
  // Callers that exclude Dwellir gain nothing from a finalized capture.
  if (input.rpcOptions.excludeSupplementalRpc || !hasRecentOnlyDwellirRoute(input.chain, input.rpcOptions)) return null;
  const finalized = await input.fetchBlockHeader(input.chain, "finalized", input.rpcOptions);
  if (!finalized) return null;
  const nowMs = Date.now();
  const observedAtSec = Math.floor(nowMs / 1000);
  if (!isFreshEvmCaptureHeader(finalized, input.nowSec, input.maxAgeSec)) return null;
  if (input.nowSec - finalized.timestamp > RECENT_FINALIZED_CAPTURE_MAX_LAG_SEC) return null;
  // `validRecentPin` re-checks this at every request, so a future timestamp is
  // never a usable observation clock.
  if (finalized.timestamp > observedAtSec) return null;
  const { deadlineMs, timeoutMs } = input.rpcOptions;
  const deadlineSec = deadlineMs == null || !Number.isFinite(deadlineMs)
    ? 0
    : Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const inFlightSec = timeoutMs == null || !Number.isFinite(timeoutMs)
    ? 0
    : Math.max(0, Math.ceil(timeoutMs / 1000));
  // The header itself stays bounded by the caller's freshness window. The pin
  // window only keeps the already-authenticated block admissible for this
  // capture's remaining state reads, so it must outlast them rather than
  // expire at the first slow Multicall batch. Callers without a deadline get
  // the measured-freshness window: an expired pin would fail reads outright,
  // while a long-lived one only lets a pruned recent node refuse and fail over.
  const pinMaxAgeSec = observedAtSec - finalized.timestamp + Math.max(
    input.maxAgeSec, DEX_MEASURED_FRESHNESS_MAX_SEC,
    deadlineSec + inFlightSec + RECENT_PIN_EXPIRY_MARGIN_SEC,
  );
  if (!Number.isSafeInteger(pinMaxAgeSec)) return null;
  const pin: RecentFinalizedRpcPin = {
    chainId: input.chain,
    header: finalized,
    finalized,
    observedAtSec,
    maxAgeSec: pinMaxAgeSec,
  };
  return { header: finalized, pin };
}

export async function runPinnedBlockCapture<TResult, TFailure = never>(input: {
  chain: string;
  rpcOptions: EvmRpcOptions;
  fetchBlockNumber?: typeof fetchEvmBlockNumber;
  fetchBlockHeader?: typeof fetchEvmBlockHeader;
  nowSec: number;
  maxAgeSec: number;
  freshnessFailureReason?: TFailure;
  verifyDeployment: (
    context: PinnedBlockCaptureContext,
  ) => Promise<PinnedCaptureCheck<TFailure>>;
  buildCalls: (
    context: PinnedBlockCaptureContext,
  ) => Promise<PinnedCaptureResult<TResult, TFailure>>;
  onResults: (results: TResult) => void | Promise<void>;
  onFailure: (reason?: TFailure) => void | Promise<void>;
}): Promise<void> {
  if (input.chain === "tron" || input.rpcOptions.chainRpcs?.get(input.chain)?.type === "tron") {
    await input.onFailure();
    return;
  }
  const fetchBlockNumber = input.fetchBlockNumber ?? fetchEvmBlockNumber;
  const fetchBlockHeader = input.fetchBlockHeader ?? fetchEvmBlockHeader;
  const recentCapture = await resolveRecentStateCapture({
    chain: input.chain,
    rpcOptions: input.rpcOptions,
    fetchBlockHeader,
    nowSec: input.nowSec,
    maxAgeSec: input.maxAgeSec,
  });
  let blockNumber: number;
  let header: EvmBlockHeader;
  let captureRpcOptions = input.rpcOptions;
  if (recentCapture) {
    blockNumber = recentCapture.header.number;
    header = recentCapture.header;
    // The finalized head is an observed head, so retained-window endpoints can
    // also serve this block's closing header read.
    captureRpcOptions = {
      ...input.rpcOptions,
      recentStatePin: recentCapture.pin,
      observedHeadBlock: recentCapture.header.number,
    };
  } else {
    const latestBlockNumber = await fetchBlockNumber(input.chain, input.rpcOptions);
    if (latestBlockNumber == null) {
      await input.onFailure();
      return;
    }
    const latestHeader = await fetchBlockHeader(input.chain, latestBlockNumber, input.rpcOptions);
    if (
      !latestHeader ||
      latestHeader.number !== latestBlockNumber
    ) {
      await input.onFailure();
      return;
    }
    blockNumber = latestBlockNumber;
    header = latestHeader;
  }
  if (!isFreshEvmCaptureHeader(header, input.nowSec, input.maxAgeSec)) {
    await input.onFailure(input.freshnessFailureReason);
    return;
  }
  const context = { blockNumber, header, rpcOptions: captureRpcOptions };
  const verified = await input.verifyDeployment(context);
  if (!verified.ok) {
    await input.onFailure(verified.reason);
    return;
  }
  const captured = await input.buildCalls(context);
  if (!captured.ok) {
    await input.onFailure(captured.reason);
    return;
  }
  const confirmedHeader = await fetchBlockHeader(input.chain, blockNumber, captureRpcOptions);
  if (
    !confirmedHeader ||
    confirmedHeader.number !== header.number ||
    confirmedHeader.hash.toLowerCase() !== header.hash.toLowerCase() ||
    confirmedHeader.timestamp !== header.timestamp ||
    !isFreshEvmCaptureHeader(confirmedHeader, input.nowSec, input.maxAgeSec)
  ) {
    await input.onFailure();
    return;
  }
  await input.onResults(captured.value);
}

export function resolveTrackedReferencePrices(input: {
  balances: readonly number[];
  assetIds: readonly (string | undefined)[];
  trackedTokenIndex: number;
  stablecoinPriceById: ReadonlyMap<string, number>;
  implyUntrackedPrices: boolean;
}): PinnedCaptureResult<{
  prices: number[];
  sources: Array<"tracked-market" | "pool-implied">;
}, never> {
  const trustedPrices = input.assetIds.map((assetId) => {
    if (!assetId) return null;
    const price = input.stablecoinPriceById.get(assetId);
    return Number.isFinite(price) && price! > 0 ? price! : null;
  });
  let trackedPrice = trustedPrices[input.trackedTokenIndex];
  let trackedSource: "tracked-market" | "pool-implied" = "tracked-market";
  if (trackedPrice == null) {
    const pricedOthers = trustedPrices.flatMap((price, index) =>
      index !== input.trackedTokenIndex && price != null ? [{ index, price }] : [],
    );
    if (pricedOthers.length !== 1) return { ok: false };
    const other = pricedOthers[0]!;
    trackedPrice =
      (input.balances[other.index]! * other.price) /
      input.balances[input.trackedTokenIndex]!;
    if (!Number.isFinite(trackedPrice) || trackedPrice <= 0) return { ok: false };
    trackedSource = "pool-implied";
  }

  const prices: number[] = [];
  const sources: Array<"tracked-market" | "pool-implied"> = [];
  for (let index = 0; index < input.balances.length; index++) {
    if (index === input.trackedTokenIndex) {
      prices[index] = trackedPrice;
      sources[index] = trackedSource;
      continue;
    }
    const trustedPrice = trustedPrices[index];
    if (trustedPrice != null) {
      prices[index] = trustedPrice;
      sources[index] = "tracked-market";
      continue;
    }
    if (!input.implyUntrackedPrices || input.assetIds[index]) return { ok: false };
    const implied =
      (input.balances[input.trackedTokenIndex]! * trackedPrice) /
      input.balances[index]!;
    if (!Number.isFinite(implied) || implied <= 0) return { ok: false };
    prices[index] = implied;
    sources[index] = "pool-implied";
  }
  return { ok: true, value: { prices, sources } };
}

export function asEvmCaptureAddress(
  chain: string,
  value: string | null | undefined,
): `0x${string}` | null {
  return canonicalEvmAddress(canonicalExitRouteScopedId(chain, value ?? ""));
}

export function mapEvmCaptureResults(
  results: readonly EvmMulticall3Result[],
): Map<string, EvmMulticall3Result> {
  return new Map(results.map((result) => [result.label, result]));
}

export function decodeEvmCaptureUint256(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "uint256" }], result.returnData);
    return value;
  } catch {
    return null;
  }
}

export function decodeEvmCaptureUint256Array(
  result: EvmMulticall3Result | undefined,
): bigint[] | null {
  if (!result?.success) return null;
  try {
    const [values] = decodeAbiParameters([{ type: "uint256[]" }], result.returnData);
    return Array.isArray(values) ? [...values] : null;
  } catch {
    return null;
  }
}

export function decodeEvmCaptureAddress(
  chain: string,
  result: EvmMulticall3Result | undefined,
): `0x${string}` | null {
  if (!result?.success) return null;
  try {
    const [address] = decodeAbiParameters([{ type: "address" }], result.returnData);
    return asEvmCaptureAddress(chain, address);
  } catch {
    return null;
  }
}

export function decodeEvmCaptureAddressArray(
  chain: string,
  result: EvmMulticall3Result | undefined,
): `0x${string}`[] | null {
  if (!result?.success) return null;
  try {
    const [values] = decodeAbiParameters([{ type: "address[]" }], result.returnData);
    if (!Array.isArray(values)) return null;
    const addresses = values.map((value) => asEvmCaptureAddress(chain, value as string));
    return addresses.some((address) => address == null) ? null : (addresses as `0x${string}`[]);
  } catch {
    return null;
  }
}

export function decodeEvmCaptureBool(result: EvmMulticall3Result | undefined): boolean | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "bool" }], result.returnData);
    return value;
  } catch {
    return null;
  }
}

export function decodeEvmCaptureString(result: EvmMulticall3Result | undefined): string | null {
  if (!result?.success) return null;
  try {
    const [value] = decodeAbiParameters([{ type: "string" }], result.returnData);
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function isFreshEvmCaptureHeader(
  header: EvmBlockHeader,
  nowSec: number,
  maxAgeSec: number,
): boolean {
  return (
    Number.isSafeInteger(nowSec) &&
    Number.isSafeInteger(header.timestamp) &&
    header.timestamp > 0 &&
    Number.isFinite(maxAgeSec) &&
    maxAgeSec >= 0 &&
    header.timestamp <= nowSec + 60 &&
    nowSec - header.timestamp <= maxAgeSec
  );
}

export function curveAmplificationFromContract(
  amplification: bigint,
  tokenCount: number,
): number | null {
  if (amplification <= 0n || !Number.isSafeInteger(tokenCount) || tokenCount < 2) return null;
  const converted = Number(amplification) / tokenCount ** (tokenCount - 1);
  return Number.isFinite(converted) && converted > 0 ? converted : null;
}

export function curveConservativeFeeRate(
  fee: bigint,
  offpegFeeMultiplier: bigint,
): number | null {
  if (fee < 0n || fee >= CURVE_STABLESWAP_FEE_DENOMINATOR || offpegFeeMultiplier < 0n) return null;
  const feeMultiplier =
    offpegFeeMultiplier > CURVE_STABLESWAP_FEE_DENOMINATOR
      ? Number(offpegFeeMultiplier) / Number(CURVE_STABLESWAP_FEE_DENOMINATOR)
      : 1;
  const feeRate = (Number(fee) / Number(CURVE_STABLESWAP_FEE_DENOMINATOR)) * feeMultiplier;
  return Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : null;
}
