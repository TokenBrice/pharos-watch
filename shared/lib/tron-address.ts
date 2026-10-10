import { sha256HexFromBytes } from "./sha256";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Validated byte identity; Base58 is case-sensitive and must never be case-folded. */
export function canonicalTronAddress(address: string): string | null {
  const value = address.trim();
  if (/^0x[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^41[0-9a-f]{40}$/i.test(value)) return `0x${value.slice(2).toLowerCase()}`;
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return null;
  let number = BigInt(0);
  for (const char of value) number = number * BigInt(58) + BigInt(BASE58_ALPHABET.indexOf(char));
  const hex = number.toString(16).padStart(50, "0");
  if (hex.length !== 50 || !hex.startsWith("41")) return null;
  const payload = Uint8Array.from(hex.slice(0, 42).match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  const first = sha256HexFromBytes(payload);
  const second = sha256HexFromBytes(Uint8Array.from(first.match(/../g)!.map((pair) => Number.parseInt(pair, 16))));
  return second.slice(0, 8) === hex.slice(42) ? `0x${hex.slice(2, 42)}` : null;
}

export function canonicalBlacklistAddress(chainId: string, address: string): string {
  return chainId === "tron" ? canonicalTronAddress(address) ?? address.trim() : address.toLowerCase();
}
