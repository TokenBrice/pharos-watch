export const DECIMALS_SELECTOR = "0x313ce567";
export const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
export const PAUSED_SELECTOR = "0x5c975abb";
export const TOTAL_VALUE_SELECTOR = "0xd4c3eea0";
export const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const BALANCE_OF_SELECTOR = "0x70a08231";
const UINT256_MAX = (1n << 256n) - 1n;

/** Encode an address as a bare 32-byte ABI argument (no 0x prefix, lowercased, left-padded). */
export function encodeAddress(address: string): string {
  const body = address.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(body)) {
    throw new Error(`Invalid ABI address: expected 20-byte hex address (${address})`);
  }
  return body.toLowerCase().padStart(64, "0");
}

/** Encode a uint256 as a bare 32-byte ABI argument (no 0x prefix, left-padded). */
export function encodeUint256(value: bigint | number): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid ABI uint256: expected non-negative safe integer (${value})`);
  }
  const uint = typeof value === "bigint" ? value : BigInt(value);
  if (uint < 0n || uint > UINT256_MAX) {
    throw new Error(`Invalid ABI uint256: value out of range (${value.toString()})`);
  }
  return uint.toString(16).padStart(64, "0");
}

export function encodeBalanceOfCallData(address: string): `0x${string}` {
  return `${BALANCE_OF_SELECTOR}${encodeAddress(address)}` as `0x${string}`;
}
