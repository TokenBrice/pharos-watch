import { describe, expect, it } from "vitest";

import { parsePositiveNumber } from "../number-utils";

describe("parsePositiveNumber", () => {
  it("accepts positive finite numbers through strict Number coercion", () => {
    expect(parsePositiveNumber(1.5)).toBe(1.5);
    expect(parsePositiveNumber("1.5")).toBe(1.5);
    expect(parsePositiveNumber(" 1.5 ")).toBe(1.5);
  });

  it("rejects zero, negative, blank, trailing-garbage, and non-finite values", () => {
    expect(parsePositiveNumber(0)).toBeNull();
    expect(parsePositiveNumber("0")).toBeNull();
    expect(parsePositiveNumber(-1)).toBeNull();
    expect(parsePositiveNumber("")).toBeNull();
    expect(parsePositiveNumber(" ")).toBeNull();
    expect(parsePositiveNumber("1.5px")).toBeNull();
    expect(parsePositiveNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parsePositiveNumber(Number.NaN)).toBeNull();
    expect(parsePositiveNumber(null)).toBeNull();
    expect(parsePositiveNumber(undefined)).toBeNull();
  });
});
