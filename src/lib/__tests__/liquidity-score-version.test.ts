import { describe, expect, it } from "vitest";
import {
  LIQUIDITY_METHODOLOGY_CHANGELOG,
  LIQUIDITY_METHODOLOGY_VERSION,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  getLiquidityMethodologyVersionAt,
  toLiquidityMethodologyVersionLabel,
} from "../liquidity-score-version";

describe("liquidity-score-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(LIQUIDITY_METHODOLOGY_CHANGELOG[0]?.version).toBe(LIQUIDITY_METHODOLOGY_VERSION);
    expect(toLiquidityMethodologyVersionLabel(LIQUIDITY_METHODOLOGY_VERSION)).toBe(LIQUIDITY_METHODOLOGY_VERSION_LABEL);
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getLiquidityMethodologyVersionAt(1771488525)).toBe("1.0");
    expect(getLiquidityMethodologyVersionAt(1771499167)).toBe("2.0");
    expect(getLiquidityMethodologyVersionAt(1772035600)).toBe("2.1");
    expect(getLiquidityMethodologyVersionAt(1772250000)).toBe("2.2");
    expect(getLiquidityMethodologyVersionAt(1772280000)).toBe("3.0");
    expect(getLiquidityMethodologyVersionAt(1772400000)).toBe("3.1");
    expect(getLiquidityMethodologyVersionAt(1772500000)).toBe("3.2");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getLiquidityMethodologyVersionAt(Number.NaN)).toBe(LIQUIDITY_METHODOLOGY_VERSION);
    expect(getLiquidityMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(LIQUIDITY_METHODOLOGY_VERSION);
  });
});
