import { describe, expect, it } from "vitest";
import { getPrevDayRaw } from "@shared/lib/supply";

describe("frontend supply alias", () => {
  it("resolves the shared supply helper through @shared", () => {
    const coin = {
      circulatingPrevDay: { peggedUSD: 900_000 },
    };

    expect(getPrevDayRaw(coin)).toBe(900_000);
  });
});
