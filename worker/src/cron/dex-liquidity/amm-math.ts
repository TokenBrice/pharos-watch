/**
 * Convert a Uniswap V3-style sqrtPriceX96 (Q64.96) to a decimal-adjusted
 * spot price: the amount of token1 you receive per 1 token0 (in human
 * decimal units). Equivalent to: given 1 unit of token0, how many token1.
 * Consumers: `USD(token0) = spotPrice * USD(token1)`.
 *
 *   sqrtRatio   = sqrt(reserve1_wei / reserve0_wei) * 2^96   (Uniswap V3 convention)
 *   ratio_raw   = (sqrtRatio / 2^96)^2                         (reserve1_wei / reserve0_wei)
 *   spotPrice   = ratio_raw * 10^(token0Decimals - token1Decimals)
 *
 * Convert the bounded uint160 ratio to a floating-point significand before
 * squaring, then apply token decimals. Squaring the BigInt first and retaining
 * only 32 raw-ratio fractional bits loses legitimate pools whenever the raw
 * ratio is tiny but the decimal adjustment brings the human price back near
 * one (for example an 18-decimal token paired with 6-decimal USDC).
 */
export function sqrtRatioToSpotPrice(
  sqrtRatio: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number {
  if (sqrtRatio <= 0n) return 0;
  const normalizedSqrtRatio = Number(sqrtRatio) / Math.pow(2, 96);
  return normalizedSqrtRatio * normalizedSqrtRatio * Math.pow(10, token0Decimals - token1Decimals);
}

const Q64 = 1n << 64n;
const MIN_TICK = -443636;
const MAX_TICK = 443636;

/**
 * PriceMath constants/formulas from Orca's Apache-2.0 revision
 * 964f84d88e9cc5a72a254f4d4e20c95b61789445 (legacy-sdk/whirlpool/src/utils/public/price-math.ts).
 * Copyright 2022 Orca Foundation. Licensed under the Apache License, Version 2.0:
 * https://www.apache.org/licenses/LICENSE-2.0
 * Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * either express or implied. See the License for permissions and limitations.
 * Modified here to use native BigInt, without SDK runtime dependencies.
 * Positive ticks use Q96 intermediates; negative ticks use Q64.
 */
const POSITIVE_FACTORS = [79232123823359799118286999567n,79236085330515764027303304731n,79244008939048815603706035061n,79259858533276714757314932305n,79291567232598584799939703904n,79355022692464371645785046466n,79482085999252804386437311141n,79736823300114093921829183326n,80248749790819932309965073892n,81282483887344747381513967011n,83390072131320151908154831281n,87770609709833776024991924138n,97234110755111693312479820773n,119332217159966728226237229890n,179736315981702064433883588727n,407748233172238350107850275304n,2098478828474011932436660412517n,55581415166113811149459800483533n,38992368544603139932233054999993551n];
const NEGATIVE_FACTORS = [18445821805675392311n,18444899583751176498n,18443055278223354162n,18439367220385604838n,18431993317065449817n,18417254355718160513n,18387811781193591352n,18329067761203520168n,18212142134806087854n,17980523815641551639n,17526086738831147013n,16651378430235024244n,15030750278693429944n,12247334978882834399n,8131365268884726200n,3584323654723342297n,696457651847595233n,26294789957452057n,37481735321082n];
export function tickSqrtPrice(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("Whirlpool tick out of range");
  const positive = tick > 0;
  const shift = positive ? 96n : 64n;
  const factors = positive ? POSITIVE_FACTORS : NEGATIVE_FACTORS;
  let ratio = 1n << shift;
  const absolute = Math.abs(tick);
  for (let i = 0; i < factors.length; i++) if (absolute & (1 << i)) ratio = (ratio * factors[i]) >> shift;
  return positive ? ratio >> 32n : ratio;
}
export function ceilDiv(n: bigint, d: bigint): bigint { return (n + d - 1n) / d; }
export function q64TokenDelta(a: bigint, b: bigint, liquidity: bigint, tokenA: boolean, roundUp: boolean): bigint {
  const difference = a > b ? a - b : b - a;
  const numerator = liquidity * difference * (tokenA ? Q64 : 1n);
  const denominator = tokenA ? a * b : Q64;
  return roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
}
