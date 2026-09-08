import { describe, expect, it } from "vitest";
import {
  deriveIndicativeDeviationBps,
  deriveGaugeDeviationBps,
  deriveSupplyFromMarketCap,
} from "../stablecoin-detail-derive";

describe("deriveSupplyFromMarketCap", () => {
  it("divides market cap by a non-unit price", () => {
    expect(deriveSupplyFromMarketCap(250_000_000, 2.5)).toBe(100_000_000);
  });
  it.each([null, undefined, 0, -1])("rejects missing or non-positive input %s", (value) => {
    expect(deriveSupplyFromMarketCap(100, value)).toBeNull();
    expect(deriveSupplyFromMarketCap(value, 1)).toBeNull();
  });
});

describe("deriveIndicativeDeviationBps", () => {
  it.each([[1.0125, 125], [0.9975, -25], [1, 0]])("projects price %s to %s bps", (price, expected) => {
    expect(deriveIndicativeDeviationBps(price, 1)).toBe(expected);
  });
  it.each([null, undefined, Number.NaN])("rejects absent or invalid price %s", (price) => {
    expect(deriveIndicativeDeviationBps(price, 1)).toBeNull();
  });
  it.each([null, 0, -1, Number.NaN])("rejects absent or invalid reference %s", (reference) => {
    expect(deriveIndicativeDeviationBps(1.01, reference)).toBeNull();
  });
});

describe("deriveGaugeDeviationBps", () => {
  it.each([[240, 240], [-30, -30], [null, 0]])("projects deviation %s with NAV precedence", (deviation, expected) => {
    expect(deriveGaugeDeviationBps(deviation, false)).toBe(expected);
    expect(deriveGaugeDeviationBps(deviation, true)).toBe(0);
  });
});
