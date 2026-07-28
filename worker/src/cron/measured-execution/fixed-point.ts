const USD_SCALE = 1_000_000n;
const PRICE_SCALE = 100_000_000n;

export const MAX_UINT64 = (1n << 64n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

export function usdToRawAmount(
  inputUsd: number,
  decimals: number,
  referencePriceUsd: number,
  options: { maxRawAmount?: bigint; maxInputUsd?: number } = {},
): bigint | null {
  if (
    !Number.isFinite(inputUsd) ||
    inputUsd <= 0 ||
    inputUsd > (options.maxInputUsd ?? Infinity) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0
  ) return null;
  const usdScaled = BigInt(Math.floor(inputUsd * Number(USD_SCALE)));
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(PRICE_SCALE)));
  if (priceScaled <= 0n) return null;
  const amount = usdScaled * 10n ** BigInt(decimals) * PRICE_SCALE / (USD_SCALE * priceScaled);
  return amount > 0n && amount <= (options.maxRawAmount ?? amount) ? amount : null;
}

export function rawAmountToUsd(
  amount: bigint,
  decimals: number,
  referencePriceUsd: number,
): number {
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(PRICE_SCALE)));
  const usdScaled = amount * priceScaled * USD_SCALE / (10n ** BigInt(decimals) * PRICE_SCALE);
  return Number(usdScaled) / Number(USD_SCALE);
}

export function rawAmountToUsdOrNull(
  amount: bigint,
  decimals: number,
  referencePriceUsd: number,
): number | null {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(PRICE_SCALE)));
  if (priceScaled <= 0n) return null;
  const usd = rawAmountToUsd(amount, decimals, referencePriceUsd);
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}
