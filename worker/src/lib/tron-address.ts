import { canonicalTronAddress } from "@shared/lib/tron-address";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BIGINT_ZERO = BigInt(0);
const BIGINT_BYTE_SHIFT = BigInt(8);
const BIGINT_BASE58 = BigInt(58);

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digestInput = new Uint8Array(bytes);
  const hash = await crypto.subtle.digest("SHA-256", digestInput.buffer as ArrayBuffer);
  return new Uint8Array(hash);
}

async function doubleSha256(bytes: Uint8Array): Promise<Uint8Array> {
  return sha256(await sha256(bytes));
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  return Uint8Array.from(normalized.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

function encodeBase58(bytes: Uint8Array): string {
  let value = BIGINT_ZERO;
  for (const byte of bytes) {
    value = (value << BIGINT_BYTE_SHIFT) | BigInt(byte);
  }

  let encoded = "";
  while (value > BIGINT_ZERO) {
    const remainder = Number(value % BIGINT_BASE58);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= BIGINT_BASE58;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }

  return encoded || "1";
}


function normalizeTronHexAddress(address: string): string | null {
  const normalized = address.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(normalized)) return normalized;
  if (/^41[0-9a-f]{40}$/.test(normalized)) return `0x${normalized.slice(2)}`;
  return null;
}

export async function tronHexAddressToBase58(address: string): Promise<string | null> {
  const normalizedHex = normalizeTronHexAddress(address);
  if (!normalizedHex) return null;
  const payload = hexToBytes(`41${normalizedHex.slice(2)}`);
  const checksum = (await doubleSha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + checksum.length);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return encodeBase58(full);
}

export async function tronBase58ToHex(address: string): Promise<string | null> {
  return /^T/.test(address.trim()) ? canonicalTronAddress(address) : null;
}

export async function normalizeTronAddress(address: string): Promise<string | null> {
  return canonicalTronAddress(address);
}

/** SQL compares hex case-insensitively, but the provider's Base58 spelling exactly. */
export async function blacklistAddressSpellings(chainId: string, address: string): Promise<[string, string, string]> {
  if (chainId !== "tron") return [address.toLowerCase(), address.toLowerCase(), address];
  const hex = canonicalTronAddress(address);
  if (!hex) return [address, address, address];
  return [hex, `41${hex.slice(2)}`, await tronHexAddressToBase58(hex) ?? address];
}
