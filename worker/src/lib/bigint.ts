/**
 * Convert a raw BigInt value to a decimal number given the token's decimals.
 */
export function bigIntToDecimal(raw: bigint, decimals: number): number {
  // For tokens with ≤15 decimals, direct division is safe.
  // For >15 decimals (rare), split to avoid precision loss.
  if (decimals <= 15) {
    return Number(raw) / 10 ** decimals;
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}
