/* Integer fixed-point boundaries for execution producers. No floating token arithmetic. */
function decimalToExitUnits(value: string, decimals: number, roundUp = false): bigint {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored linear unsigned-decimal shape; groups cannot overlap.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid-execution-decimal");
  const fraction = match[2] ?? "";
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals).padEnd(decimals, "0")) || "0");
  return units + (roundUp && /[1-9]/.test(fraction.slice(decimals)) ? 1n : 0n);
}

function exitNumberToDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid-execution-value");
  const [coefficient, exponentText] = String(value).toLowerCase().split("e");
  if (exponentText === undefined) return coefficient!;
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = whole! + fraction;
  const position = whole!.length + Number(exponentText);
  return position <= 0 ? `0.${"0".repeat(-position)}${digits}` : position >= digits.length ? digits + "0".repeat(position - digits.length) : `${digits.slice(0, position)}.${digits.slice(position)}`;
}

export function requestedExitRawInput(requestedUsd: number, priceUsd: number, decimals: number): bigint {
  const usd = decimalToExitUnits(exitNumberToDecimal(requestedUsd), 18, true);
  const price = decimalToExitUnits(exitNumberToDecimal(priceUsd), 18);
  if (price <= 0n) throw new Error("execution-input-price-unavailable");
  return (usd * 10n ** BigInt(decimals) + price - 1n) / price;
}

export function exitRawUsd(raw: bigint, decimals: number, unitPriceUsd: number): bigint {
  return raw * decimalToExitUnits(exitNumberToDecimal(unitPriceUsd), 18) / 10n ** BigInt(decimals);
}

export function exitUsdBoundary(rawUsd: bigint): number {
  // Round down only at the existing numeric curve boundary.
  return Number(rawUsd / 10n ** 12n) / 1_000_000;
}
