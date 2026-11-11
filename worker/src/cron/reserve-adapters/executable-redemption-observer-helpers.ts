import type { Abi } from "abitype";
import { normalizeEvmAddress } from "./evm";
import { abiObservation, type AnyEvmObservationField, type EvmCodeIdentity } from "./evm-observation-plan";
import { fail } from "./executable-redemption-read-client";

type Hex = `0x${string}`;
export interface ProxyIdentity extends EvmCodeIdentity {
  address: Hex;
  codeHash: Hex;
  implementationAddress: Hex;
  implementationCodeHash: Hex;
}

export interface DirectIdentity extends EvmCodeIdentity {
  address: Hex;
  codeHash: Hex;
}
export function fixedPointFeeBpsCeil(rawFee: bigint, scale: bigint, coinId: string): number {
  if (rawFee < 0n || rawFee > scale) fail(coinId, "fee is outside the supported 0-100% range");
  const bps = (rawFee * 10_000n + scale - 1n) / scale;
  if (bps > 10_000n) fail(coinId, "fee bps exceeds 100%");
  return Number(bps);
}

export function verifyExpectedAddress(coinId: string, label: string, expected: string) {
  return (value: unknown): null => {
    const normalized = typeof value === "string" ? normalizeEvmAddress(value) : null;
    if (!normalized) fail(coinId, `${label} returned an invalid address`);
    if (normalized !== expected) fail(coinId, "live route dependency identity drift");
    return null;
  };
}
type AbiFieldOptions = {
  args?: readonly unknown[];
  verify?: (value: unknown) => string | null;
};

export function abiField(
  label: string,
  contract: string,
  abi: Abi,
  functionName: string,
  options: AbiFieldOptions = {},
): AnyEvmObservationField {
  return abiObservation({
    label,
    contract,
    abi,
    functionName,
    ...options,
  });
}
