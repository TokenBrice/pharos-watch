export const DECIMALS_SELECTOR = "0x313ce567";
export const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
export const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const BALANCE_OF_SELECTOR = "0x70a08231";

export function encodeBalanceOfCallData(address: string): `0x${string}` {
  const normalizedAddress = address.startsWith("0x") ? address.slice(2) : address;
  return `${BALANCE_OF_SELECTOR}${normalizedAddress.toLowerCase().padStart(64, "0")}` as `0x${string}`;
}
