import { describe, expect, it } from "vitest";
import { getPrevDayRawOrNull } from "@shared/lib/supply";

describe("frontend supply alias", () => {
  it("resolves the shared supply helper through @shared", () => {
    const coin = {
      circulatingPrevDay: { peggedUSD: 900_000 },
    };

    expect(getPrevDayRawOrNull(coin)).toBe(900_000);
    expect(getPrevDayRawOrNull({ circulatingPrevDay: {} })).toBeNull();
    expect(getPrevDayRawOrNull({ circulatingPrevDay: { peggedUSD: 0 } })).toBe(0);
  });
});
