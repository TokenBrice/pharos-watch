const UNIT = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type SolidlyV2MathVariant = "aerodrome" | "velodrome" | "shadow";

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
function shadowF(x: bigint, y: bigint): bigint {
  return add(mul(x, mul(mul(y, y) / UNIT, y) / UNIT) / UNIT,
    mul(mul(mul(x, x) / UNIT, x) / UNIT, y) / UNIT);
}
function derivative(x: bigint, y: bigint): bigint {
  return add(mul(mul(3n, x), mul(y, y) / UNIT) / UNIT, mul(mul(x, x) / UNIT, x) / UNIT);
}

export interface SolidlyV2QuoteState {
  reserve0: bigint;
  reserve1: bigint;
  decimals0: number;
  decimals1: number;
  stable: boolean;
  fee: bigint;
  variant: SolidlyV2MathVariant;
}

/** Pool.getAmountOut, including fee flooring, decimal scaling, Newton termination and reverts. */
export function quoteSolidlyV2Raw(state: SolidlyV2QuoteState, amountIn: bigint, tokenInIndex: 0 | 1): bigint | null {
  try {
    if (!Number.isInteger(state.decimals0) || !Number.isInteger(state.decimals1) ||
      state.decimals0 < 0 || state.decimals1 < 0 || state.decimals0 > 77 || state.decimals1 > 77 ||
      state.reserve0 <= 0n || state.reserve1 <= 0n || amountIn < 0n || state.fee < 0n) return null;
    const denominator = state.variant === "shadow" ? 1_000_000n : 10_000n;
    if (state.fee >= denominator) return null;
    const net = sub(checked(amountIn), mul(amountIn, state.fee) / denominator);
    const scale0 = 10n ** BigInt(state.decimals0);
    const scale1 = 10n ** BigInt(state.decimals1);
    let output: bigint;
    if (!state.stable) {
      const reserveA = tokenInIndex === 0 ? state.reserve0 : state.reserve1;
      const reserveB = tokenInIndex === 0 ? state.reserve1 : state.reserve0;
      output = mul(net, reserveB) / add(reserveA, net);
    } else {
      const x = mul(state.reserve0, UNIT) / scale0;
      const y = mul(state.reserve1, UNIT) / scale1;
      const k = invariant(x, y);
      const reserveA = tokenInIndex === 0 ? x : y;
      const reserveB = tokenInIndex === 0 ? y : x;
      const x0 = add(reserveA, mul(net, UNIT) / (tokenInIndex === 0 ? scale0 : scale1));
      let remaining = reserveB;
      let converged = false;
      for (let iteration = 0; iteration < 255; iteration++) {
        const previous = remaining;
        const f = state.variant === "shadow" ? shadowF(x0, remaining) : invariant(x0, remaining);
        const d = derivative(x0, remaining);
        if (d === 0n) return null;
        let dy = mul(f < k ? k - f : f - k, UNIT) / d;
        if (state.variant !== "shadow" && dy === 0n) {
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
        if (state.variant === "shadow" && (remaining > previous ? remaining - previous : previous - remaining) <= 1n) {
          converged = true;
          break;
        }
      }
      if (!converged && state.variant !== "shadow") return null;
      output = mul(sub(reserveB, remaining), tokenInIndex === 0 ? scale1 : scale0) / UNIT;
    }
    return state.variant === "shadow" ? sub(output, 1n) : output;
  } catch {
    return null;
  }
}
