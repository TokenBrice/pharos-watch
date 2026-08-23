export function canonicalEvmAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function canonicalEvmHash(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

export function decodeAddressResult(input: { decode: () => unknown }): `0x${string}` | null {
  try {
    return canonicalEvmAddress(input.decode());
  } catch {
    return null;
  }
}
