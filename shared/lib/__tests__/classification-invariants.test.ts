import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeCentralizedCustodyFraction } from "@shared/lib/centralized-custody";

const MAJORITY_THRESHOLD = 0.50;

describe("classification invariants", () => {
  it("does not allow decentralized coins with >50% centralized-custody exposure", () => {
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

    expect(warnings).toEqual([]);
  });
});
