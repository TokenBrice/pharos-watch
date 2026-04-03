export function decimalStringFromBigInt(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(decimals + 1, "0");
  const integerPart = digits.slice(0, digits.length - decimals) || "0";
  const fractionalPart = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fractionalPart.length > 0
    ? `${negative ? "-" : ""}${integerPart}.${fractionalPart}`
    : `${negative ? "-" : ""}${integerPart}`;
}

export function decimalNumberFromBigInt(value: bigint, decimals: number): number {
  return Number(decimalStringFromBigInt(value, decimals));
}

/**
 * Convert a raw BigInt value to a decimal number given the token's decimals.
 */
export function bigIntToDecimal(raw: bigint, decimals: number): number {
  return decimalNumberFromBigInt(raw, decimals);
}
