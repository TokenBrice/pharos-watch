import { describe, expect, it } from "vitest";
import {
  MAX_UINT64,
  MAX_UINT128,
  MAX_UINT256,
  rawAmountToUsd,
  rawAmountToUsdOrNull,
  usdToRawAmount,
} from "../fixed-point";

describe("measured-execution fixed-point conversions", () => {
  it.each([
    [1, 6, 1, 1_000_000n],
    [1.25, 6, 1, 1_250_000n],
    [10, 18, 2, 5_000_000_000_000_000_000n],
    [0.000001, 6, 1, 1n],
  ])("converts %s USD at %s decimals and %s reference price", (usd, decimals, price, expected) => {
    expect(usdToRawAmount(usd, decimals, price)).toBe(expected);
  });

  it.each([
    [0, 6, 1],
    [-1, 6, 1],
    [Number.NaN, 6, 1],
    [1, -1, 1],
    [1, 256, 1],
    [1, 6.5, 1],
    [1, 6, 0],
    [1, 6, Number.POSITIVE_INFINITY],
  ])("rejects invalid USD conversion input %#", (usd, decimals, price) => {
    expect(usdToRawAmount(usd, decimals, price)).toBeNull();
  });

  it.each([
    [MAX_UINT64],
    [MAX_UINT128],
    [MAX_UINT256],
  ])("honors the raw amount ceiling %s", (maxRawAmount) => {
    expect(usdToRawAmount(Number(maxRawAmount + 1n), 0, 1, { maxRawAmount })).toBeNull();
  });

  it("honors an adapter-specific safe USD input ceiling", () => {
    const maxInputUsd = Number.MAX_SAFE_INTEGER / 1_000_000;
    expect(usdToRawAmount(maxInputUsd + 1, 6, 1, { maxInputUsd })).toBeNull();
  });

  it("preserves checked and unchecked raw-to-USD behavior", () => {
    expect(rawAmountToUsd(1_250_000n, 6, 1)).toBe(1.25);
    expect(rawAmountToUsdOrNull(0n, 6, 1)).toBe(0);
    expect(rawAmountToUsdOrNull(-1n, 6, 1)).toBeNull();
    expect(rawAmountToUsdOrNull(1n, -1, 1)).toBeNull();
    expect(rawAmountToUsdOrNull(1n, 6, 0)).toBeNull();
  });
});
