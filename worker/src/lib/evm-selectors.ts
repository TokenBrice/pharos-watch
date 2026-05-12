export const DECIMALS_SELECTOR = "0x313ce567";
export const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
export const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const BALANCE_OF_SELECTOR = "0x70a08231";

/** Encode an address as a bare 32-byte ABI argument (no 0x prefix, lowercased, left-padded). */
export function encodeAddressArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Encode a uint256 as a bare 32-byte ABI argument (no 0x prefix, left-padded). */
export function encodeUint256Arg(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

export function encodeBalanceOfCallData(address: string): `0x${string}` {
  return `${BALANCE_OF_SELECTOR}${encodeAddressArg(address)}` as `0x${string}`;
}
