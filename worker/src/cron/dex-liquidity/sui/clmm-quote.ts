import { tickSqrtPrice } from "../solana/whirlpool-quote";
import { suiCoinType } from "./identity";
import type { SuiClmmSnapshot, SuiClmmTick } from "./state-reader";

const Q64 = 1n << 64n;
const MAX_U64 = Q64 - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;
const FEE_DENOMINATOR = 1_000_000n;
const MAX_STEPS = 4096;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new Error("sui-clmm-invalid-division");
  return (numerator + denominator - 1n) / denominator;
}
function tokenDelta(a: bigint, b: bigint, liquidity: bigint, coinA: boolean, roundUp: boolean): bigint {
  const difference = a > b ? a - b : b - a;
  const numerator = liquidity * difference * (coinA ? Q64 : 1n);
  if (numerator > MAX_U256) throw new Error("sui-clmm-u256-overflow");
  const denominator = coinA ? a * b : Q64;
  return roundUp ? ceilDiv(numerator, denominator) : numerator / denominator;
}

export interface SuiClmmQuote {
  amountIn: bigint; amountOut: bigint; feeAmount: bigint; protocolFeeAmount: bigint;
  sqrtPriceAfter: bigint; crossedTicks: number; steps: number; checkpoint: string;
}

/** Complete tick census proves there is no liquidity beyond this initialized
 * edge. Bounding inspection here avoids thousands of provably empty words. */
export function suiClmmDirectionalPriceLimit(snapshot: SuiClmmSnapshot, aToB: boolean): bigint {
  for (let i = aToB ? 0 : snapshot.ticks.length - 1; aToB ? i < snapshot.ticks.length : i >= 0; i += aToB ? 1 : -1) {
    const tick = snapshot.ticks[i];
    if (tick.liquidityGross > 0n && (aToB ? tick.sqrtPrice < snapshot.pool.sqrtPrice : tick.sqrtPrice > snapshot.pool.sqrtPrice)) return tick.sqrtPrice;
  }
  throw new Error("sui-clmm-liquidity-exhausted");
}

/** Cetus and Bluefin share the Q64 invariant and input ceiling/output floor.
 * Unlike Whirlpool, their partial step consumes all the fee-discounted input,
 * not a re-rounded price delta. Bluefin also rounds at empty bitmap-word edges. */
export function quoteSuiClmmExactIn(snapshot: SuiClmmSnapshot, coinTypeIn: string, amountIn: bigint): SuiClmmQuote {
  const { pool, ticks } = snapshot;
  const input = suiCoinType(coinTypeIn);
  if (input !== pool.coinA && input !== pool.coinB) throw new Error("sui-clmm-input-identity-mismatch");
  if (amountIn <= 0n || amountIn > MAX_U64) throw new Error("sui-clmm-input-outside-u64");
  if (ticks.length !== pool.tickCount) throw new Error("sui-clmm-incomplete-tick-census");
  if (!Number.isInteger(pool.feePips) || pool.feePips < 0 || pool.feePips >= 1_000_000 || pool.liquidity < 0n || pool.liquidity > MAX_U128) throw new Error("sui-clmm-invalid-state");
  const aToB = input === pool.coinA;
  const priceLimit = suiClmmDirectionalPriceLimit(snapshot, aToB);
  const feeRate = BigInt(pool.feePips);
  let remaining = amountIn;
  let amountOut = 0n;
  let feeAmount = 0n;
  let protocolFeeAmount = 0n;
  let sqrtPrice = pool.sqrtPrice;
  let liquidity = pool.liquidity;
  let currentTick = pool.currentTick;
  let crossedTicks = 0;
  let steps = 0;
  while (remaining > 0n) {
    if (++steps > MAX_STEPS) throw new Error("sui-clmm-step-budget-exhausted");
    let lowerIndex = 0;
    let upperIndex = ticks.length;
    while (lowerIndex < upperIndex) {
      const middle = (lowerIndex + upperIndex) >>> 1;
      if (ticks[middle].index <= currentTick) lowerIndex = middle + 1;
      else upperIndex = middle;
    }
    const directionalIndex = aToB ? lowerIndex - 1 : lowerIndex;
    let initialized: SuiClmmTick | undefined;
    let nextIndex: number;
    if (pool.family === "cetus") {
      initialized = ticks[directionalIndex];
      if (!initialized) throw new Error("sui-clmm-liquidity-exhausted");
      nextIndex = initialized.index;
    } else {
      // Equivalent to a directional masked 256-bit bitmap word search. The
      // state reader proves the complete table and its bitmap agree first.
      const compressed = Math.floor(currentTick / pool.tickSpacing) + (aToB ? 0 : 1);
      const wordStart = Math.floor(compressed / 256) * 256;
      const lower = wordStart * pool.tickSpacing;
      const upper = (wordStart + 255) * pool.tickSpacing;
      for (let index = directionalIndex; index >= 0 && index < ticks.length; index += aToB ? -1 : 1) {
        const candidate = ticks[index];
        if (candidate.index < lower || candidate.index > upper) break;
        if (candidate.liquidityGross > 0n) { initialized = candidate; break; }
      }
      nextIndex = initialized?.index ?? (aToB ? lower : upper);
      nextIndex = Math.max(-443636, Math.min(443636, nextIndex));
    }
    const target = tickSqrtPrice(nextIndex);
    if (aToB ? target > sqrtPrice : target < sqrtPrice) throw new Error("sui-clmm-price-direction-mismatch");
    let nextPrice = target;
    let consumed = 0n;
    let stepFee = 0n;
    let output = 0n;
    if (liquidity > 0n && target !== sqrtPrice) {
      const available = remaining * (FEE_DENOMINATOR - feeRate) / FEE_DENOMINATOR;
      const required = tokenDelta(sqrtPrice, target, liquidity, aToB, true);
      if (required > available) {
        consumed = available;
        stepFee = remaining - available;
        if (available === 0n) nextPrice = sqrtPrice;
        else if (aToB) {
          const numerator = liquidity * sqrtPrice * Q64;
          if (numerator > MAX_U256) throw new Error("sui-clmm-u256-overflow");
          nextPrice = ceilDiv(numerator, liquidity * Q64 + available * sqrtPrice);
        } else nextPrice = sqrtPrice + available * Q64 / liquidity;
      } else {
        consumed = required;
        stepFee = ceilDiv(consumed * feeRate, FEE_DENOMINATOR - feeRate);
      }
      output = tokenDelta(sqrtPrice, nextPrice, liquidity, !aToB, false);
    }
    if (consumed + stepFee > remaining || output > MAX_U64 - amountOut || stepFee > MAX_U64 - feeAmount) throw new Error("sui-clmm-amount-overflow");
    remaining -= consumed + stepFee;
    amountOut += output;
    feeAmount += stepFee;
    // Protocol fees are a share of the total fee, not a second trader charge.
    protocolFeeAmount += pool.family === "cetus"
      ? ceilDiv(stepFee * BigInt(pool.protocolFeeRate), 10_000n)
      : stepFee * BigInt(pool.protocolFeeRate) / FEE_DENOMINATOR;
    sqrtPrice = nextPrice;
    if (nextPrice === target) {
      if (initialized) {
        liquidity += aToB ? -initialized.liquidityNet : initialized.liquidityNet;
        crossedTicks++;
        if (liquidity < 0n || liquidity > MAX_U128) throw new Error("sui-clmm-crossing-liquidity-overflow");
      }
      currentTick = aToB ? nextIndex - 1 : nextIndex;
      if (remaining > 0n && (nextPrice === priceLimit || (aToB ? nextIndex === -443636 : nextIndex === 443636))) throw new Error("sui-clmm-liquidity-exhausted");
    }
    if (nextPrice < tickSqrtPrice(-443636) || nextPrice > tickSqrtPrice(443636)) throw new Error("sui-clmm-price-outside-bounds");
  }
  return { amountIn, amountOut, feeAmount, protocolFeeAmount, sqrtPriceAfter: sqrtPrice, crossedTicks, steps, checkpoint: snapshot.checkpoint };
}
