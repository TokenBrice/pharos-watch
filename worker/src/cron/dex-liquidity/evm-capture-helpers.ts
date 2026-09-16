import { canonicalExitRouteScopedId } from "@shared/lib/exit-route-identity";
import { decodeAbiParameters } from "viem/utils";

import type { EvmBlockHeader, EvmMulticall3Result } from "../../lib/evm-rpc";

const CURVE_STABLESWAP_FEE_DENOMINATOR = 10n ** 10n;

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

export function isFreshEvmCaptureHeader(
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
