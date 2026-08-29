const ZERO_EVM_ADDRESS = `0x${"0".repeat(40)}` as const;

/** Canonicalize a 20-byte EVM address without throwing. */
export function canonicalEvmAddress(
  value: unknown,
  { allowZero = true }: { allowZero?: boolean } = {},
): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return null;
  if (!allowZero && normalized === ZERO_EVM_ADDRESS) return null;
  return normalized as `0x${string}`;
}
