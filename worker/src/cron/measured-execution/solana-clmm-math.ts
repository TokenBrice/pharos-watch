/**
 * Narrow, integer-only replay for a Raydium CLMM swap that stays inside the
 * currently active liquidity segment. It is deliberately not a generic CLMM
 * engine: callers must reject a route unless this result exactly matches the
 * provider's strict direct quote and returned post-swap sqrt price.
 */

const Q64 = 1n << 64n;

export interface RaydiumClmmSingleSegmentQuoteInput {
  liquidity: string;
  sqrtPriceX64: string;
  amountIn: string;
  feeAmount: string;
  direction: "zero-for-one" | "one-for-zero";
}

export interface RaydiumClmmSingleSegmentQuote {
  amountOut: string;
  postSwapSqrtPriceX64: string;
}

function parsePositive(value: string, label: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`raydium-onstate-invalid-${label}`);
  return BigInt(value);
}

function parseNonNegative(value: string, label: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`raydium-onstate-invalid-${label}`);
  return BigInt(value);
}

function divideCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("raydium-onstate-invalid-denominator");
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Replays one un-crossed Raydium CLMM liquidity segment. A caller must bind
 * mint order and reject any output/post-price mismatch; that makes tick
 * crossings, dynamic-fee changes, transfer-fee effects, and unsupported
 * account layouts fail closed rather than silently approximating execution.
 */
export function quoteRaydiumClmmSingleSegment(
  input: RaydiumClmmSingleSegmentQuoteInput,
): RaydiumClmmSingleSegmentQuote {
  const liquidity = parsePositive(input.liquidity, "liquidity");
  const sqrtPrice = parsePositive(input.sqrtPriceX64, "sqrt-price");
  const amountIn = parsePositive(input.amountIn, "amount-in");
  const feeAmount = parseNonNegative(input.feeAmount, "fee-amount");
  if (feeAmount >= amountIn) throw new Error("raydium-onstate-invalid-fee-amount");
  const amountAfterFee = amountIn - feeAmount;

  if (input.direction === "zero-for-one") {
    const denominator = liquidity * Q64 + amountAfterFee * sqrtPrice;
    const postSwapSqrtPrice = divideCeil(liquidity * sqrtPrice * Q64, denominator);
    if (postSwapSqrtPrice >= sqrtPrice) throw new Error("raydium-onstate-invalid-price-direction");
    const amountOut = (liquidity * (sqrtPrice - postSwapSqrtPrice)) / Q64;
    return {
      amountOut: amountOut.toString(),
      postSwapSqrtPriceX64: postSwapSqrtPrice.toString(),
    };
  }

  const postSwapSqrtPrice = sqrtPrice + divideCeil(amountAfterFee * Q64, liquidity);
  const amountOut = (liquidity * (postSwapSqrtPrice - sqrtPrice) * Q64) / (postSwapSqrtPrice * sqrtPrice);
  return {
    amountOut: amountOut.toString(),
    postSwapSqrtPriceX64: postSwapSqrtPrice.toString(),
  };
}
