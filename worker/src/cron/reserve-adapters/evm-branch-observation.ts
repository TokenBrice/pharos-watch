const ADAPTER_KEY = "evm-branch-balances";

export function requireUint(value: bigint | null, label: string): bigint {
  if (value == null) throw new Error(`${ADAPTER_KEY}: ${label} read failed`);
  return value;
}

export function addressFromWord(value: bigint | null, label: string): string {
  const raw = requireUint(value, label);
  if (raw === 0n || raw >= 1n << 160n) throw new Error(`${ADAPTER_KEY}: ${label} returned invalid address`);
  return `0x${raw.toString(16).padStart(40, "0")}`;
}

export function decodeWords(raw: string | null, label: string): bigint[] {
  const hex = raw?.startsWith("0x") ? raw.slice(2) : null;
  if (hex == null || hex.length === 0 || hex.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed data`);
  }
  const words: bigint[] = [];
  for (let offset = 0; offset < hex.length; offset += 64) {
    words.push(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  }
  return words;
}

export function decodeUintArray(raw: string | null, expectedLength: number, label: string): bigint[] {
  const words = decodeWords(raw, label);
  const offsetBytes = words[0];
  if (offsetBytes % 32n !== 0n || offsetBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned invalid offset`);
  }
  const offset = Number(offsetBytes / 32n);
  const lengthWord = words[offset];
  if (lengthWord == null || lengthWord !== BigInt(expectedLength)) {
    throw new Error(`${ADAPTER_KEY}: ${label} length mismatch`);
  }
  const values = words.slice(offset + 1, offset + 1 + expectedLength);
  if (values.length !== expectedLength) throw new Error(`${ADAPTER_KEY}: ${label} returned truncated data`);
  return values;
}
