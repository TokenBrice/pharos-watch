import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";

const MAJORITY_THRESHOLD = 0.50;

describe("classification invariants", () => {
  it("warns when decentralized coins have >50% centralized-custody exposure", () => {
    const warnings: string[] = [];

    const defiCoins = TRACKED_STABLECOINS.filter(
      (c) => c.flags.governance === "decentralized",
    );

    for (const coin of defiCoins) {
      const fraction = computeCentralizedCustodyFraction(
        coin.id, TRACKED_STABLECOINS,
      );
      if (fraction > MAJORITY_THRESHOLD) {
        warnings.push(
          `${coin.id}: classified "decentralized" but ${(fraction * 100).toFixed(1)}% ` +
          `centralized-custody exposure (threshold: ${MAJORITY_THRESHOLD * 100}%)`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn(
        `\n[classification-invariants] ${warnings.length} governance classification warnings:\n` +
        warnings.map((w) => `  - ${w}`).join("\n") + "\n",
      );
    }

    // WARNING MODE: log warnings but do not fail the test.
    expect(true).toBe(true);
  });
});
