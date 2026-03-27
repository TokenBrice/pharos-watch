const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(BASE58_ALPHABET.split("").map((char, index) => [char, index]));
const BIGINT_ZERO = BigInt(0);
const BIGINT_BYTE_SHIFT = BigInt(8);
const BIGINT_BASE58 = BigInt(58);
const BIGINT_BYTE_MASK = BigInt(0xff);

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function decodeBase58(value: string): Uint8Array | null {
  let decoded = BIGINT_ZERO;
  for (const char of value) {
    const index = BASE58_INDEX.get(char);
    if (index == null) return null;
    decoded = decoded * BIGINT_BASE58 + BigInt(index);
  }

  const bytes: number[] = [];
  while (decoded > BIGINT_ZERO) {
    bytes.unshift(Number(decoded & BIGINT_BYTE_MASK));
    decoded >>= BIGINT_BYTE_SHIFT;
  }

  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }

  return Uint8Array.from(bytes);
}

function normalizeTronHexAddress(address: string): string | null {
  const normalized = address.trim().toLowerCase();
  if (normalized.startsWith("0x") && normalized.length === 42) return normalized;
  if (normalized.startsWith("41") && normalized.length === 42) return `0x${normalized.slice(2)}`;
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
  const decoded = decodeBase58(address.trim());
  if (!decoded || decoded.length < 5) return null;
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const expected = (await doubleSha256(payload)).slice(0, 4);
  if (checksum.length !== expected.length || checksum.some((byte, index) => byte !== expected[index])) {
    return null;
  }
  if (payload[0] !== 0x41 || payload.length !== 21) return null;
  return `0x${bytesToHex(payload.slice(1)).toLowerCase()}`;
}

export async function normalizeTronAddress(address: string): Promise<string | null> {
  return normalizeTronHexAddress(address) ?? tronBase58ToHex(address);
}
