const UNIT = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type SolidlyV2MathVariant = "aerodrome" | "velodrome";

function checked(value: bigint): bigint {
  if (value < 0n || value > MAX_UINT256) throw new RangeError("Solidly uint256 overflow");
  return value;
}
const mul = (a: bigint, b: bigint) => checked(a * b);
const add = (a: bigint, b: bigint) => checked(a + b);
const sub = (a: bigint, b: bigint) => checked(a - b);

/** Keep Solidity's operation order: algebraic simplification changes integer rounding. */
function invariant(x: bigint, y: bigint): bigint {
  return mul(mul(x, y) / UNIT, add(mul(x, x) / UNIT, mul(y, y) / UNIT)) / UNIT;
}
function derivative(x: bigint, y: bigint): bigint {
  return add(mul(mul(3n, x), mul(y, y) / UNIT) / UNIT, mul(mul(x, x) / UNIT, x) / UNIT);
}

export interface SolidlyV2QuoteState {
  reserve0: bigint;
  reserve1: bigint;
  decimals0: number;
  decimals1: number;
  stable: true;
  fee: bigint;
  variant: SolidlyV2MathVariant;
}

/** Pool.getAmountOut, including fee flooring, decimal scaling, Newton termination and reverts. */
export function quoteSolidlyV2Raw(state: SolidlyV2QuoteState, amountIn: bigint, tokenInIndex: 0 | 1): bigint | null {
  try {
    if (!Number.isInteger(state.decimals0) || !Number.isInteger(state.decimals1) ||
      state.decimals0 < 0 || state.decimals1 < 0 || state.decimals0 > 77 || state.decimals1 > 77 ||
      state.reserve0 <= 0n || state.reserve1 <= 0n || amountIn < 0n || state.fee < 0n ||
      state.stable !== true || !["aerodrome", "velodrome"].includes(state.variant)) return null;
    const denominator = 10_000n;
    if (state.fee >= denominator) return null;
    const net = sub(checked(amountIn), mul(amountIn, state.fee) / denominator);
    const scale0 = 10n ** BigInt(state.decimals0);
    const scale1 = 10n ** BigInt(state.decimals1);
    const x = mul(state.reserve0, UNIT) / scale0;
    const y = mul(state.reserve1, UNIT) / scale1;
    const k = invariant(x, y);
    const reserveA = tokenInIndex === 0 ? x : y;
    const reserveB = tokenInIndex === 0 ? y : x;
    const x0 = add(reserveA, mul(net, UNIT) / (tokenInIndex === 0 ? scale0 : scale1));
    let remaining = reserveB;
    let converged = false;
    for (let iteration = 0; iteration < 255; iteration++) {
      const f = invariant(x0, remaining);
      const d = derivative(x0, remaining);
      if (d === 0n) return null;
      let dy = mul(f < k ? k - f : f - k, UNIT) / d;
      if (dy === 0n) {
        if (f < k) {
          // Aerodrome's deployed implementation calls _k here (not _f),
          // so its decimal scaling must be retained even on normalized inputs.
          const next = state.variant === "aerodrome"
            ? invariant(mul(x0, UNIT) / scale0, mul(add(remaining, 1n), UNIT) / scale1)
            : invariant(x0, add(remaining, 1n));
          if (next > k) { remaining = add(remaining, 1n); converged = true; break; }
        } else if (f === k || invariant(x0, sub(remaining, 1n)) < k) {
          converged = true;
          break;
        }
        dy = 1n;
      }
      remaining = f < k ? add(remaining, dy) : sub(remaining, dy);
    }
    if (!converged) return null;
    return mul(sub(reserveB, remaining), tokenInIndex === 0 ? scale1 : scale0) / UNIT;
  } catch {
    return null;
  }
}

/** Same fixed-point conversion for collection, capacity refinement and proof replay. */
export function solidlyUsdToRawAmount(inputUsd: number, decimals: number, priceUsd: number): bigint | null {
  if (!Number.isFinite(inputUsd) || inputUsd <= 0 || !Number.isInteger(decimals) || decimals < 0 ||
    decimals > 77 || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const scaledUsd = Math.floor(inputUsd * 1_000_000);
  const scaledPrice = Math.round(priceUsd * 100_000_000);
  if (!Number.isFinite(scaledUsd) || !Number.isFinite(scaledPrice) || scaledPrice <= 0) return null;
  const amount = BigInt(scaledUsd) * 10n ** BigInt(decimals) * 100_000_000n /
    (1_000_000n * BigInt(scaledPrice));
  return amount > 0n && amount <= MAX_UINT256 ? amount : null;
}
