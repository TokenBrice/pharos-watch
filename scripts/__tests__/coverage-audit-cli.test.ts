import { describe, expect, it } from "vitest";

import { numberValue, stringValue } from "../lib/coverage-audit-cli";

describe("coverage audit CLI helpers", () => {
  it("normalizes finite numbers and trimmed non-empty strings", () => {
    expect(numberValue(12.5)).toBe(12.5);
    expect(numberValue(Number.NaN)).toBeNull();
    expect(numberValue("12.5")).toBeNull();

    expect(stringValue("  USDC  ")).toBe("USDC");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(42)).toBeNull();
  });

  it("can preserve untrimmed non-empty strings for legacy callers", () => {
    expect(stringValue("  USDC  ", { trim: false })).toBe("  USDC  ");
    expect(stringValue("", { trim: false })).toBeNull();
  });
});
