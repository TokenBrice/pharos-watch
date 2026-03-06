import { describe, expect, it } from "vitest";

import {
  PSI_ELIGIBLE_IDS,
  PSI_ELIGIBLE_STABLECOINS,
} from "@shared/lib/psi-eligible";

describe("PSI_ELIGIBLE_IDS", () => {
  it("is non-empty", () => {
    expect(PSI_ELIGIBLE_IDS.size).toBeGreaterThan(0);
  });

  it("contains exactly the stablecoins in PSI_ELIGIBLE_STABLECOINS", () => {
    expect(PSI_ELIGIBLE_IDS.size).toBe(PSI_ELIGIBLE_STABLECOINS.length);
  });

  it("includes major stablecoins from the source registry", () => {
    const eligibleIds = PSI_ELIGIBLE_STABLECOINS.map((coin) => coin.id);
    const eligibleFromSource = new Set(eligibleIds);

    expect(eligibleFromSource.has("usdt-tether")).toBe(true);
    expect(eligibleFromSource.has("usdc-circle")).toBe(true);
    expect(eligibleFromSource.has("dai-makerdao")).toBe(true);
    expect(PSI_ELIGIBLE_IDS.has("usdt-tether")).toBe(true);
    expect(PSI_ELIGIBLE_IDS.has("usdc-circle")).toBe(true);
    expect(PSI_ELIGIBLE_IDS.has("dai-makerdao")).toBe(true);
  });
});
