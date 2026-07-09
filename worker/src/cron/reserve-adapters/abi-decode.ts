import { decodeAbiParameters } from "viem/utils";

const ABI_WORD_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/;

export function decodeUint256Word(raw: string | null | undefined): bigint | null {
  if (typeof raw !== "string" || !ABI_WORD_HEX_PATTERN.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export function decodeBoolWord(raw: string | null | undefined): boolean | null {
  const value = decodeUint256Word(raw);
  return value == null ? null : value !== 0n;
}

export function decodeUint8Word(raw: string | null | undefined): number | null {
  const value = decodeUint256Word(raw);
  if (value == null || value > 255n) return null;
  return Number(value);
}

export function decodeAddressWord(raw: string | null | undefined): `0x${string}` | null {
  if (typeof raw !== "string" || !ABI_WORD_HEX_PATTERN.test(raw)) return null;
  const address = `0x${raw.slice(-40)}` as `0x${string}`;
  return ZERO_ADDRESS_PATTERN.test(address) ? null : address;
}

export function decodeAddressArrayWord(raw: string | null | undefined): `0x${string}`[] | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    const [addresses] = decodeAbiParameters(
      [{ type: "address[]" }],
      raw as `0x${string}`,
    ) as readonly [`0x${string}`[]];
    return addresses.map((address) => address.toLowerCase() as `0x${string}`);
  } catch {
    return null;
  }
}

export function decodeBytes32ArrayWord(raw: string | null | undefined): `0x${string}`[] | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    const [items] = decodeAbiParameters(
      [{ type: "bytes32[]" }],
      raw as `0x${string}`,
    ) as readonly [`0x${string}`[]];
    return items.map((item) => item.toLowerCase() as `0x${string}`);
  } catch {
    return null;
  }
}
