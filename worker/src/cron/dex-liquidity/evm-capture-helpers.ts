import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import { decodeAbiParameters } from "viem/utils";

import {
  fetchEvmBlockHeader,
  fetchEvmBlockNumber,
  type EvmBlockHeader,
  type EvmMulticall3Result,
  type EvmRpcOptions,
} from "../../lib/evm-rpc";

const CURVE_STABLESWAP_FEE_DENOMINATOR = 10n ** 10n;
export type PinnedCaptureCheck<TFailure> = { ok: true } | { ok: false; reason?: TFailure };

export type PinnedCaptureResult<TResult, TFailure> =
  | { ok: true; value: TResult }
  | { ok: false; reason?: TFailure };

interface PinnedBlockCaptureContext {
  blockNumber: number;
  header: EvmBlockHeader;
}

export async function runPinnedBlockCapture<TResult, TFailure = never>(input: {
  chain: string;
  rpcOptions: EvmRpcOptions;
  fetchBlockNumber?: typeof fetchEvmBlockNumber;
  fetchBlockHeader?: typeof fetchEvmBlockHeader;
  nowSec?: number;
  maxAgeSec?: number;
  verifyDeployment: (
    context: PinnedBlockCaptureContext,
  ) => Promise<PinnedCaptureCheck<TFailure>>;
  buildCalls: (
    context: PinnedBlockCaptureContext,
  ) => Promise<PinnedCaptureResult<TResult, TFailure>>;
  onResults: (results: TResult) => void | Promise<void>;
  onFailure: (reason?: TFailure) => void | Promise<void>;
}): Promise<void> {
  const fetchBlockNumber = input.fetchBlockNumber ?? fetchEvmBlockNumber;
  const fetchBlockHeader = input.fetchBlockHeader ?? fetchEvmBlockHeader;
  const blockNumber = await fetchBlockNumber(input.chain, input.rpcOptions);
  if (blockNumber == null) {
    await input.onFailure();
    return;
  }
  const header = await fetchBlockHeader(input.chain, blockNumber, input.rpcOptions);
  if (
    !header ||
    header.number !== blockNumber ||
    (input.nowSec != null &&
      input.maxAgeSec != null &&
      !isFreshEvmCaptureHeader(header, input.nowSec, input.maxAgeSec))
  ) {
    await input.onFailure();
    return;
  }
  const context = { blockNumber, header };
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
  const confirmedHeader = await fetchBlockHeader(input.chain, blockNumber, input.rpcOptions);
  if (
    !confirmedHeader ||
    confirmedHeader.number !== header.number ||
    confirmedHeader.hash.toLowerCase() !== header.hash.toLowerCase() ||
    (input.nowSec != null &&
      input.maxAgeSec != null &&
      !isFreshEvmCaptureHeader(confirmedHeader, input.nowSec, input.maxAgeSec))
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
  const normalized = canonicalExitRouteScopedId(chain, value ?? "");
  return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
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
