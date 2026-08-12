import { decodeAbiParameters } from "viem/utils";

const ABI_WORD_HEX_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/;
const PADDED_ADDRESS_WORD_PATTERN = /^0{24}[0-9a-f]{40}$/;
const ABI_WORD_HEX_LENGTH = 64;

/**
 * Word-indexed accessor over a raw ABI return payload. The whole payload must
 * be a non-empty multiple of 32 bytes, so a truncated response is rejected
 * rather than silently read past its end.
 */
export function decodeAbiWordAt(
  raw: string | null | undefined,
  index: number,
): `0x${string}` | null {
  if (typeof raw !== "string" || !raw.startsWith("0x") || index < 0) return null;
  const hex = raw.slice(2);
  if (
    hex.length === 0 ||
    hex.length % ABI_WORD_HEX_LENGTH !== 0 ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    return null;
  }
  const start = index * ABI_WORD_HEX_LENGTH;
  const end = start + ABI_WORD_HEX_LENGTH;
  if (end > hex.length) return null;
  return `0x${hex.slice(start, end)}` as `0x${string}`;
}

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

/**
 * Strict single-word boolean: exactly one ABI word of value 0 or 1. Route
 * pause/shutdown probes use this so a fallback-function echo or packed payload
 * reads as "surface unreadable" (null) instead of as pause evidence.
 */
export function decodeStrictBoolWord(raw: string | null | undefined): boolean | null {
  const value = decodeUint256Word(raw);
  if (value === 0n) return false;
  if (value === 1n) return true;
  return null;
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

/**
 * Strict counterpart of `decodeAddressWord`: the upper 12 bytes must be zero
 * padding, and the zero address is a valid decode rather than a rejection.
 */
export function decodeStrictAddressWord(
  raw: string | null | undefined,
): `0x${string}` | null {
  if (typeof raw !== "string" || !ABI_WORD_HEX_PATTERN.test(raw)) return null;
  const word = raw.slice(2).toLowerCase();
  return PADDED_ADDRESS_WORD_PATTERN.test(word)
    ? (`0x${word.slice(-40)}` as `0x${string}`)
    : null;
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

/**
 * Strict counterpart of `decodeAddressArrayWord`: the head offset must be a
 * whole number of words pointing past the head, every element must carry clean
 * address padding, and the declared length must stay within `maxItems`.
 */
export function decodeStrictAddressArrayWord(
  raw: string | null | undefined,
  options: { maxItems: number },
): `0x${string}`[] | null {
  const offsetBytes = decodeUint256Word(decodeAbiWordAt(raw, 0));
  if (offsetBytes == null || offsetBytes % 32n !== 0n) return null;
  const offsetWords = Number(offsetBytes / 32n);
  if (!Number.isSafeInteger(offsetWords) || offsetWords < 1) return null;
  const length = decodeUint256Word(decodeAbiWordAt(raw, offsetWords));
  if (length == null || length > BigInt(options.maxItems)) return null;
  const lengthNumber = Number(length);
  const addresses: `0x${string}`[] = [];
  for (let index = 0; index < lengthNumber; index += 1) {
    const address = decodeStrictAddressWord(
      decodeAbiWordAt(raw, offsetWords + 1 + index),
    );
    if (address == null) return null;
    addresses.push(address);
  }
  return addresses;
}

export function decodeBytes32ArrayWord(
  raw: string | null | undefined,
  options: { maxItems?: number } = {},
): `0x${string}`[] | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) return null;
  const { maxItems } = options;
  if (maxItems != null) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 0 || raw.length < 130) return null;
    try {
      const arrayOffsetBytes = Number(BigInt(`0x${raw.slice(2, 66)}`));
      if (!Number.isSafeInteger(arrayOffsetBytes) || arrayOffsetBytes < 0) return null;
      const arrayLengthWordStart = 2 + arrayOffsetBytes * 2;
      const arrayLengthWordEnd = arrayLengthWordStart + 64;
      if (arrayLengthWordEnd > raw.length) return null;
      const itemCount = BigInt(`0x${raw.slice(arrayLengthWordStart, arrayLengthWordEnd)}`);
      if (itemCount > BigInt(maxItems)) return null;
    } catch {
      return null;
    }
  }
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
