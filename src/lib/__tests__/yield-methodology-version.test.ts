import { describe, expect, it } from "vitest";
import {
  YIELD_METHODOLOGY_CHANGELOG,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
  getYieldMethodologyVersionAt,
  toYieldMethodologyVersionLabel,
} from "@shared/lib/yield-methodology-version";

describe("yield-methodology-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(YIELD_METHODOLOGY_CHANGELOG[0]?.version).toBe(YIELD_METHODOLOGY_VERSION);
    expect(toYieldMethodologyVersionLabel(YIELD_METHODOLOGY_VERSION)).toBe(YIELD_METHODOLOGY_VERSION_LABEL);
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getYieldMethodologyVersionAt(1772370811)).toBe("1.0");
    expect(getYieldMethodologyVersionAt(1772375700)).toBe("1.1");
    expect(getYieldMethodologyVersionAt(1772378600)).toBe("2.0");
    expect(getYieldMethodologyVersionAt(1772380200)).toBe("2.1");
    expect(getYieldMethodologyVersionAt(1772380600)).toBe("3.0");
    expect(getYieldMethodologyVersionAt(1772387000)).toBe("3.1");
    expect(getYieldMethodologyVersionAt(1772460000)).toBe("3.2");
    expect(getYieldMethodologyVersionAt(1772530000)).toBe("3.3");
    expect(getYieldMethodologyVersionAt(1772560000)).toBe("4.0");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getYieldMethodologyVersionAt(Number.NaN)).toBe(YIELD_METHODOLOGY_VERSION);
    expect(getYieldMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(YIELD_METHODOLOGY_VERSION);
  });
});
