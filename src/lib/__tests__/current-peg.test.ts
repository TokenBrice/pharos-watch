import { describe, expect, it } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { isCurrentDeviationHeld, resolveCurrentDeviationBps } from "@/lib/current-peg";

const SUNDAY = 1_794_758_400; // 2026-11-15 16:00 UTC: FX and metals shut
const MONDAY = 1_794_844_800; // 2026-11-16 16:00 UTC: reopened

describe("isCurrentDeviationHeld", () => {
  it.each([
    { peg: "GOLD", at: SUNDAY, bps: 300, held: true },
    { peg: "EUR", at: SUNDAY, bps: -300, held: true },
    { peg: "GOLD", at: SUNDAY, bps: null, held: false },
    { peg: "USD", at: SUNDAY, bps: 300, held: false },
    { peg: "GOLD", at: MONDAY, bps: 300, held: false },
    { peg: "GOLD", at: SUNDAY, bps: -2_500, held: false },
    { peg: "GOLD", at: null, bps: 300, held: false },
  ])("$peg at $at for $bps bps is held=$held", ({ peg, at, bps, held }) => {
    expect(isCurrentDeviationHeld(peg, at, bps)).toBe(held);
  });

  it("withholds a held published deviation", () => {
    const row = makeStablecoin({ id: "xaut-tether", pegType: "peggedGOLD", price: 3_030, priceSource: "coingecko", priceObservedAt: SUNDAY });
    row.currentPeg = {
      currentDeviationBps: 300, pegReference: null, pegReferenceUnavailable: false,
      currentPriceUnavailable: false, primaryTrust: "unusable", dexPriceCheck: null,
    };
    expect(resolveCurrentDeviationBps(row, null, "GOLD")).toBeNull();
  });
});
