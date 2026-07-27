import { describe, expect, it } from "vitest";
import raydiumWmFixture from "./fixtures/raydium-wm-usdc-single-segment-2026-07-27.json";
import { quoteRaydiumClmmSingleSegment } from "../solana-clmm-math";
import { parseRaydiumClmmPoolState } from "../solana-quotes";

describe("Raydium CLMM single-segment replay", () => {
  it("matches the pinned wM/USDC direct quote captured from the same pool state", () => {
    const state = parseRaydiumClmmPoolState({
      accountDataBase64: raydiumWmFixture.pool.accountDataBase64,
      owner: raydiumWmFixture.pool.programId,
      slot: raydiumWmFixture.pool.slot,
    });
    expect(state).toMatchObject({
      tokenMint0: raydiumWmFixture.pool.tokenMint0,
      tokenMint1: raydiumWmFixture.pool.tokenMint1,
      liquidity: raydiumWmFixture.pool.liquidity,
      sqrtPriceX64: raydiumWmFixture.pool.sqrtPriceX64,
    });

    const replay = quoteRaydiumClmmSingleSegment({
      liquidity: state!.liquidity,
      sqrtPriceX64: state!.sqrtPriceX64,
      amountIn: raydiumWmFixture.directQuote.amountIn,
      feeAmount: raydiumWmFixture.directQuote.feeAmount,
      direction: "zero-for-one",
    });

    expect(replay).toEqual({
      amountOut: raydiumWmFixture.directQuote.amountOut,
      postSwapSqrtPriceX64: raydiumWmFixture.directQuote.lastPoolPriceX64,
    });
  });

  it("rejects an account with the wrong program owner", () => {
    expect(parseRaydiumClmmPoolState({
      accountDataBase64: raydiumWmFixture.pool.accountDataBase64,
      owner: "11111111111111111111111111111111",
      slot: raydiumWmFixture.pool.slot,
    })).toBeNull();
  });

  it("does not approximate a quote when its fee evidence is invalid", () => {
    expect(() => quoteRaydiumClmmSingleSegment({
      liquidity: raydiumWmFixture.pool.liquidity,
      sqrtPriceX64: raydiumWmFixture.pool.sqrtPriceX64,
      amountIn: raydiumWmFixture.directQuote.amountIn,
      feeAmount: raydiumWmFixture.directQuote.amountIn,
      direction: "zero-for-one",
    })).toThrow("raydium-onstate-invalid-fee-amount");
  });
});
