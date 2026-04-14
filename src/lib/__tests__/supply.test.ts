import { describe, expect, it } from "vitest";
import { getPrevDayRaw } from "@shared/lib/supply";
import type { StablecoinData } from "@shared/types";

describe("frontend supply alias", () => {
  it("resolves the shared supply helper through @shared", () => {
    const coin = {
      circulatingPrevDay: { peggedUSD: 900_000 },
    } as StablecoinData;

    expect(getPrevDayRaw(coin)).toBe(900_000);
  });
});
