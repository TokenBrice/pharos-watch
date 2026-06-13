import { describe, expect, it } from "vitest";

import { isFiniteNumber, isRecord, numberValue, stringValue } from "../type-guards";

describe("isRecord", () => {
  it("accepts plain objects and rejects null, arrays, and primitives", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(["value"])).toBe(false);
    expect(isRecord("value")).toBe(false);
  });
});

describe("stringValue", () => {
  it("returns trimmed non-empty strings by default", () => {
    expect(stringValue("  USDC  ")).toBe("USDC");
  });

  it("returns null for blank strings and non-strings", () => {
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(42)).toBeNull();
  });

  it("can preserve whitespace for payload fields that already own normalization", () => {
    expect(stringValue("  USDC  ", { trim: false })).toBe("  USDC  ");
    expect(stringValue("", { trim: false })).toBeNull();
  });
});

describe("numberValue", () => {
  it("returns finite numbers only", () => {
    expect(numberValue(42)).toBe(42);
    expect(numberValue(NaN)).toBeNull();
    expect(numberValue(Infinity)).toBeNull();
    expect(numberValue("42")).toBeNull();
  });
});

describe("isFiniteNumber", () => {
  it("narrows finite numbers only", () => {
    expect(isFiniteNumber(42)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber("42")).toBe(false);
  });
});
